# Execution Flow

1. `src/index.ts` loads configuration and creates the core dependencies.
2. `ApplicationFramework` initializes services and plugins in dependency order.
3. `WhatsAppConnection` starts the Baileys transport and normalizes incoming events.
4. The framework dispatches commands through prefix, validation, cooldown, and permission checks.
5. Services persist operational state in their owned storage and optional external integrations remain feature-gated.
6. Shutdown reverses plugin, transport, and service lifecycle ownership.

Use `tables/calls.csv`, `tables/commands.csv`, and `tables/services.csv` to trace a particular path.
