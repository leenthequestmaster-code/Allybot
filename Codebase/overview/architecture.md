# Architecture Map

Allybot starts from `src/index.ts`, loads validated configuration, creates SQLite operational storage, creates the WhatsApp adapter, registers services and plugins, initializes the framework lifecycle, and starts the WhatsApp transport. The import, call, service, command, and data-flow tables provide the detailed cross-reference.

Operational storage, protocol/session state, feature services, optional external Neon/PostgreSQL and Upstash Redis integrations, and command/plugin boundaries remain separate in the map. This document is a navigation aid; the source snapshot remains authoritative for implementation details.
