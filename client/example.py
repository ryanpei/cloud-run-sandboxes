# Standard Developer Python script template
# This code block runs natively inside the secure gVisor sandbox in the cloud!
import math
import sys

print("---------------------------------------------------------")
print("Hello from inside the secure, isolated gVisor microVM!")
print("---------------------------------------------------------")

# Perform standard calculations
radius = 5.5
area = math.pi * (radius ** 2)
print(f"Area of circle with radius {radius} is: {area:.4f}")

# Check sys configs
print(f"Active Python Interpreter: {sys.executable}")
print(f"Command line arguments received: {sys.argv}")
print(f"Standard modules imported successfully.")
print("---------------------------------------------------------")
