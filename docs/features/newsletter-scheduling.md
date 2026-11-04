# Newsletter scheduled delivery

- Scheduling creates a one-time delivery.
- The UI accepts Asia/Seoul local time; the API and D1 store UTC ISO timestamps.
- A schedule must be at least five minutes in the future and no more than 30 days ahead.
- A Worker Cron Trigger checks due schedules every minute. Cloudflare Cron Triggers run on UTC.
- The email content is generated at send time from the user's latest seven days of summarized news; the preview HTML is not snapshotted when the schedule is created.
- A schedule can be cancelled while its status is scheduled. Once processing begins, it cannot be cancelled.
- Failed sends are recorded in D1 and are not automatically retried to avoid duplicate email delivery. Create a new schedule to retry manually.

## Deployment

Run from the repository root:

    Set-Location C:\dev\news-for-me
    npx wrangler d1 migrations apply news-for-me-db --remote --config .\apps\worker\wrangler.jsonc
    npx wrangler deploy --config .\apps\worker\wrangler.jsonc

The Worker deployment activates the every-minute Cron Trigger configured in wrangler.jsonc. Deploy the Pages frontend through the repository's existing Pages deployment flow.
