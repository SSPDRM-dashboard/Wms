# Cloud WMS – Source Code Starter

This is a deployable cloud-oriented WMS starter for two companies. It includes:
- Company selection and company-separated inventory
- Bluetooth HID scanner input (scanner types into the scan box and sends Enter)
- Company-specific QR parsing profiles (based on the sample label photos)
- Container receiving with a pending scan list and explicit Complete Container action
- Inventory search and CSV export
- FIFO outbound issuing
- Stock transfer
- BOM storage/retrieval API
- Movement history and inventory summary
- JWT login and Admin/Supervisor/Operator role checks for protected admin APIs

## Important scope notes
This is a functional starter/MVP, not a fully validated production WMS. The QR field positions are inferred from the sample label images and must be verified using exact raw scanner output. Company B's pallet QR is treated as a reference only; the individual box-content QR is what adds stock. The browser currently stages scans in memory; the backend commits them atomically when Complete Container is pressed. Do not close/reload the page before completion or pending scans will be lost.

Cycle counting, shipping-list import, production wave planning, alerting, multi-site controls, full user administration UI, password reset, automated backups, audit exports, and formal deployment hardening remain future milestones. Use HTTPS, strong secrets, restricted CORS, database backups, and a managed PostgreSQL service before live warehouse use.

## Run locally with Docker
1. Install Docker Desktop or Docker Engine with Compose.
2. Copy `.env.example` to `.env`.
3. Change `POSTGRES_PASSWORD`, `JWT_SECRET`, and `ADMIN_PASSWORD`.
4. Run: `docker compose up -d --build`
5. Open `http://localhost:8080`
6. API documentation: `http://localhost:8000/docs` (or `/docs` through the web host).

## Cloud deployment
Use a cloud VM or container platform that supports Docker Compose, plus a persistent disk or managed PostgreSQL. Configure:
- DNS name and HTTPS certificate
- Strong unique environment secrets
- `CORS_ORIGINS` to your actual web domain
- PostgreSQL backups and restore testing
- Firewall: expose only HTTPS (443); keep database private
- Monitoring and log retention

Do not expose port 5432 publicly. The included Compose file exposes API port 8000 and web port 8080 for initial testing; in production, put a TLS reverse proxy/load balancer in front and restrict direct API access.

## QR format mapping (needs confirmation)
Company A sample is split by `_`: part number = segment 2, quantity = segment 4, box = segment 5, optional batch/reference = segment 6.
Company B box sample is split by `/`: part and quantity are in segment 2 separated by `&`; batch = segment 3; box = segment 4.
Company B pallet sample is recognised as a pallet reference only and does not create inventory.

## Bluetooth scanner
Set scanner to Bluetooth HID/keyboard mode and configure suffix = Enter/CR if available. The scanner must be 2D-capable to read QR codes. Test Code 128 and QR with the exact scanner model. If the scanner adds AIM identifiers or prefixes, update `qr_parser.py`.

## Database migrations
For this starter, tables are created automatically on startup. Before production, add Alembic migrations and test schema upgrades.

## Main API
- `POST /api/login`
- `GET /api/companies`
- `POST /api/scan/parse`
- `POST /api/containers/complete`
- `GET /api/inventory?company_id=1&search=...`
- `POST /api/outbound`
- `POST /api/transfer`
- `GET /api/movements?company_id=1`
- `GET /api/reports/summary?company_id=1`
- `GET/POST /api/bom`
- `GET/POST /api/users` (Admin)

## Default login
Username and password are controlled by `ADMIN_USERNAME` and `ADMIN_PASSWORD` in `.env`. Change the defaults before deployment.
