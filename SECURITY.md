# Security policy

## Reporting a vulnerability

Please report security issues privately, not in public issues or pull requests:

- GitHub: **Security → Report a vulnerability** on this repository (private advisory), or
- Email: contact@sacha-cohen.fr with the subject `[Scalo security]`.

Include the affected version or commit, the steps to reproduce and the impact you expect.
You will get an acknowledgement within 3 working days. Please give us 90 days to ship a fix
before disclosing publicly; we credit reporters in the release notes unless you prefer otherwise.

## Supported versions

Only the latest release and the `main` branch receive security fixes.

## Running Scalo safely

- Set a long random `JWT_SECRET` (it signs sessions, contact cookies, unsubscribe and preview links).
- Serve the app over HTTPS and set `TRUST_PROXY` only when it runs behind a reverse proxy you control.
- With several API instances, keep `AUTO_MIGRATE` off and run migrations as a deploy step. The bundled
  single-container Docker setup (`docker-compose.prod.yml`) applies them at startup, under a database lock.
- Set `ALLOW_SIGNUPS=false` once your account exists if the instance is not meant to be open to the public.
- Restrict network access to PostgreSQL to the application.
