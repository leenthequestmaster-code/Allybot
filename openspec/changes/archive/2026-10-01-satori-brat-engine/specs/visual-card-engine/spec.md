# Spec Delta: visual-card-engine

## ADDED Requirements

### Requirement: Satori-Powered Brat Album Cover Generator
The visual card engine SHALL render an authentic "Brat" cover image (`!brat`) using Satori and Resvg based on local Arimo-Regular TTF font, text justification, binary search font scaling, and Gaussian blur.

#### Scenario: User requests Brat cover generation
- **WHEN** a user invokes `!brat <text>` with text between 1 and 200 characters
- **THEN** the engine normalizes the text to lowercase
- **AND** binary searches the optimal font size to fit within a 720x720 canvas with 30px padding
- **AND** justifies all non-final lines with space-between alignment and left-aligns the final line
- **AND** renders the text with letter-spacing -2px, line-height 0.95, and a Gaussian blur filter of stdDeviation 3
- **AND** outputs a 2x PNG buffer (1440x1440).
