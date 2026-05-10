# MasterJi Notifier

A Cloudflare Worker that fetches tasks from MasterJi (Supabase API) and sends real-time Discord notifications for new assignments and deadlines.

## Features

- **Task Monitoring**: Automatically fetches new tasks from MasterJi API
- **Discord Integration**: Sends instant notifications to Discord when new tasks are detected
- **Smart Deduplication**: Tracks seen tasks to avoid duplicate notifications
- **Token Management**: Auto-refreshes access tokens to maintain API connectivity
- **Lightweight**: Runs serverless on Cloudflare Workers with zero cold starts
- **Reliable Storage**: Uses Cloudflare D1 for token caching and task tracking

## Prerequisites

- Cloudflare account with Workers and D1 database access
- MasterJi API credentials (access token, refresh token, batch ID)
- Supabase project with REST API enabled
- Discord webhook URL (optional, for notifications)
- Node.js and npm installed locally

## Installation

1. **Clone or download this repository**

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Create and configure the D1 database**
   ```bash
   wrangler d1 create masterji-notifier
   ```
   Update the `database_id` in `wrangler.toml` with the generated ID.

4. **Initialize the database schema**
   ```bash
   wrangler d1 execute masterji-notifier --file=schema.sql
   ```

5. **Set up environment secrets**
   ```bash
   wrangler secret put MASTERJI_ACCESS_TOKEN
   wrangler secret put MASTERJI_REFRESH_TOKEN
   wrangler secret put MASTERJI_BATCH_ID
   wrangler secret put MASTERJI_API_BASE
   wrangler secret put SUPABASE_ANON_KEY
   wrangler secret put DISCORD_WEBHOOK_URL
   # Optional:
   wrangler secret put MASTERJI_AUTH_BASE
   ```

6. **Deploy to Cloudflare**
   ```bash
   wrangler deploy
   ```

## Configuration

### Environment Variables (Secrets)

| Variable | Description | Required |
|----------|-------------|----------|
| `MASTERJI_ACCESS_TOKEN` | JWT access token for MasterJi API | Yes |
| `MASTERJI_REFRESH_TOKEN` | Refresh token for token renewal | Yes |
| `MASTERJI_BATCH_ID` | Batch ID to filter tasks by cohort | Yes |
| `MASTERJI_API_BASE` | Supabase REST API base URL | Yes |
| `SUPABASE_ANON_KEY` | Supabase anonymous key | Yes |
| `DISCORD_WEBHOOK_URL` | Discord webhook URL for notifications | No |
| `MASTERJI_AUTH_BASE` | Supabase Auth URL (auto-derived if omitted) | No |

### Wrangler Configuration

Edit `wrangler.toml` to customize:
- Worker name and entry point
- D1 database binding
- Scheduled cron triggers (optional)

**Example cron setup** (uncomment to enable):
```toml
[triggers]
crons = ["*/5 * * * *"]   # Check every 5 minutes
```

## API Endpoints

### `GET /`
Health check endpoint. Returns a simple response to verify the worker is running.

```bash
curl https://your-worker.your-domain.workers.dev/
```

### `GET /check`
Fetches new tasks from MasterJi API and sends Discord notifications.

```bash
curl https://your-worker.your-domain.workers.dev/check
```

**Response:**
```json
{
  "success": true,
  "new_tasks": 3,
  "total_notified": 3
}
```

## Database Schema

### `token_cache`
Stores authentication tokens with expiration tracking.

```sql
CREATE TABLE token_cache (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  access_token  TEXT NOT NULL,
  refresh_token TEXT NOT NULL,
  expires_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
```

### `seen_task`
Tracks tasks that have already been notified to prevent duplicates.

```sql
CREATE TABLE seen_task (
  id          TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  name        TEXT NOT NULL,
  due         TEXT NOT NULL,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
```

## How It Works

1. **Token Management**: On startup, the worker checks if cached tokens are still valid. If expired, it refreshes them using the refresh token.

2. **Task Fetching**: Queries the MasterJi API for tasks associated with the batch ID.

3. **Deduplication**: Compares fetched tasks against the `seen_task` table to identify new tasks only.

4. **Notifications**: For each new task, sends a Discord message via webhook and records the task in the database.

5. **Error Handling**: Gracefully handles token expiration, API failures, and network issues.

## Development

### Local Testing

Test the endpoints locally using Wrangler's local development server:

```bash
wrangler dev
```

Then visit:
- `http://localhost:8787/` - health check
- `http://localhost:8787/check` - trigger task check

### Viewing Database

Query your D1 database directly:

```bash
wrangler d1 execute masterji-notifier --command "SELECT * FROM seen_task;"
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| 401 Unauthorized | Check that access/refresh tokens are correct and not expired |
| No tasks found | Verify `MASTERJI_BATCH_ID` matches your cohort ID |
| Discord notifications not sent | Confirm `DISCORD_WEBHOOK_URL` is valid and not expired |
| Token refresh fails | Ensure `MASTERJI_AUTH_BASE` is correctly configured or auto-derivable |
| Database errors | Re-run `wrangler d1 execute masterji-notifier --file=schema.sql` |

## License

MIT License - see [LICENSE](LICENSE) for details.

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests for improvements.

## Support

For issues or questions, please open a GitHub issue or contact the project maintainer.
