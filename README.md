# Vercel OpenAI Proxy

## Deploy
1. `vercel` (hoặc import project từ GitHub vào Vercel)
2. Set env:
   - `OPENAI_API_KEY=sk-...`
   - (optional) `PROXY_INTERNAL_API_KEY=your-shared-key`
3. Deploy production.

## Endpoint
- POST `https://<your-app>.vercel.app/v1/chat/completions`
- Header (nếu bật PROXY_INTERNAL_API_KEY):
  - `x-api-key: your-shared-key`

## Test
curl -X POST "https://<your-app>.vercel.app/v1/chat/completions" \
  -H "Content-Type: application/json" \
  -H "x-api-key: your-shared-key" \
  -d '{
    "model":"gpt-4o-mini",
    "messages":[{"role":"user","content":"hello"}]
  }'
