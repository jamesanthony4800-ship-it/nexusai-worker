# Deploying the NexusAI worker to Railway

1. In Railway: New Project -> Deploy from GitHub repo -> select nexusai-worker.
2. Add a Volume mounted at /data (this is where monitor baselines persist).
3. In the service's Variables, add:
   NEXUSAI_BASE_URL = your NexusAI app URL (same value as the GitHub repo secret)
   WORKER_API_KEY   = same value as the NexusAI app's WORKER_API_KEY secret
   XAI_API_KEY      = your x.ai key
   POLL_INTERVAL_MS = 15000 (optional)
4. Deploy. The service listens on $PORT and answers 200 on any path (health).
5. Verify: check Logs for "health endpoint listening" and job claims,
   and open the service's public URL (generate a domain) to see {"ok":true,...}.
6. GitHub Actions cron can stay on as backup; disable it once Railway is proven.
