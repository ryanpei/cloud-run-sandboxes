import { LlmAgent, FunctionTool } from '@google/adk';
import { z } from 'zod';
import { execFile } from 'child_process';

// The standard location of the local Sandbox CLI bind-mounted in Cloud Run
const SANDBOX_CLI = '/usr/local/gcp/bin/sandbox';

/**
 * Utility: Promisified execFile wrapper. Runs the Sandbox CLI safely using static string array
 * arguments, completely eliminating process stream pipeline hangs.
 */
function runSandboxProcess(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string; cmd: string }> {
  return new Promise((resolve) => {
    const cmdText = `${SANDBOX_CLI} ${args.join(' ')}`;
    console.log(`[CLI Trigger] ${cmdText}`);

    // execFile directly executes the target binary, neutralizing argument-injection attacks.
    execFile(SANDBOX_CLI, args, (error, stdout, stderr) => {
      let exitCode = 0;
      if (error) {
        exitCode = error.code !== undefined && typeof error.code === 'number' ? error.code : 1;
      }
      resolve({
        exitCode,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        cmd: cmdText
      });
    });
  });
}

// Declare the Custom Sandbox-Isolated Shell command interpreter wrapping local CLI 'do' commands
const executeShellTool = new FunctionTool({
  name: 'execute_shell_command',
  description: 'Executes arbitrary POSIX shell/bash commands inside a highly secure, isolated local sandbox VM. Use this tool to run mathematical calculations, examine systems, or verify directories. IMPORTANT: The guest VM sandbox has an empty PATH env. You MUST specify absolute system paths for all commands inside your scripts (e.g., use /bin/echo instead of echo, use /bin/ls instead of ls, use /bin/cat instead of cat). Perform math using standard shell arithmetic expansion: /bin/echo $((expression)).',
  parameters: z.object({
    command: z.string().describe('The complete, self-contained shell/bash command string to execute inside the sandbox.')
  }),
  execute: async ({ command }): Promise<string> => {
    console.log(`================================================================`);
    console.log(`[ADK Sandbox Tool] Starting secure ephemeral shell run...`);
    console.log(`================================================================`);

    // Map command targeting the user-proven 'sandbox do -- /bin/sh -c <cmd>' pattern!
    // Explicitly targets guest absolute path /bin/sh to bypass empty PATH lookup perimeters.
    const args = ['do', '--', '/bin/sh', '-c', command];

    try {
      console.log(`[ADK Sandbox Tool] Spawning sandbox guest shell...`);
      const result = await runSandboxProcess(args);

      if (result.exitCode !== 0) {
        return `Execution Failed!\nExit Code: ${result.exitCode}\nStdout Log:\n${result.stdout}\nStderr Log:\n${result.stderr}`;
      }

      console.log(`[ADK Sandbox Tool] Ephemeral sandbox command successfully completed.`);
      return result.stdout;

    } catch (err) {
      console.error(`[ADK Sandbox Tool ERROR]`, err);
      return `Internal Sandbox Tool Error: ${(err as Error).message}`;
      
    } finally {
      console.log(`================================================================`);
    }
  }
});

// Define and Export the Root Agent to be loaded dynamically by the ADK Web UI Server
export const rootAgent = new LlmAgent({
  name: 'secure_coding_assistant',
  description: 'ADK agent capable of writing, executing, and validating shell commands safely inside isolated local Cloud Run Sandboxes.',
  model: process.env.GEMINI_MODEL || 'gemini-2.5-flash', // Fallback to gemini-2.5-flash if not specified
  instruction: 'You are a highly capable ADK agent. When users ask you to run calculations, examine directories, or test commands, ALWAYS generate and execute the command using the execute_shell_command tool before finalizing your response. Remember that the guest VM sandbox has a restricted empty PATH, so you MUST ALWAYS specify absolute binary paths for guest tools (e.g. use /bin/echo instead of echo, use /bin/ls instead of ls). Tell the user what command was run.',
  tools: [executeShellTool]
});
