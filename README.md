# Scrobble Relay

Mobile-friendly local web app to search TMDb, build a Plex-style `media.scrobble` movie payload, and POST it to webhook containers.

## Features
- Search movies on TMDb.
- Send the payload to one or more webhook endpoints.
- Meant to sit behind Authelia or another auth layer.

## Setup
1. Create a TMDb API key.
2. Edit `docker-compose.yml.sample` and set:
   - `TMDB_API_KEY`
   - `WEBHOOKS`
3. Start it:
   ```bash
   docker compose up -d --build
   ```
4. Open `http://host:3000`.
