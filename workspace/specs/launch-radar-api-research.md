# Launch Radar Data Sources API Specs

## 1. Birdeye API - New Token Listings
**Endpoint:** `GET https://public-api.birdeye.so/defi/v2/tokens/new_listing`
**Purpose:** Retrieves a list of newly listed tokens across supported blockchains.

**Authentication & Headers:**
- `x-api-key`: `YOUR_API_KEY` (Required)
- `x-chain`: `solana` (Optional, defaults to solana. Other values: `ethereum`, `bsc`, `base`, etc.)

**Rate Limits (Free Tier / Standard):**
- 1 Request Per Second (RPS) account-level limit. (Paid tiers go up to 100 RPS).

**Example cURL:**
```bash
curl --request GET \
  --url 'https://public-api.birdeye.so/defi/v2/tokens/new_listing?limit=10&meme_platform_enabled=false' \
  --header 'x-api-key: YOUR_API_KEY' \
  --header 'x-chain: solana'
```

**Response Shape Example:**
```json
{
  "success": true,
  "data": {
    "items": [
      {
        "address": "DezXAZ8z7PnrnMcqzR2S6Q4VzR8iJC5KGNuCUsGpy69A",
        "symbol": "BONK",
        "name": "Bonk",
        "source": "raydium",
        "liquidityAddedAt": "2022-12-29T10:00:00Z",
        "logoURI": "https://...",
        "liquidity": 1500000.5
      }
    ]
  }
}
```

---

## 2. DexScreener API - New Pairs / Tokens
**Endpoint:** `GET https://api.dexscreener.com/token-profiles/latest/v1`
**Purpose:** Returns an array of the most recently updated token profiles (often used as a proxy for newly active pairs, since developers update profiles upon launch).
*Note:* There is no single endpoint that streams every raw new pair creation instantly; developers poll this endpoint to find newly indexed profiles.

**Authentication & Headers:**
- No API key or authentication headers required for the public beta.

**Rate Limits:**
- 60 requests per minute for the `token-profiles/latest/v1` endpoint. (Standard pair search is 300 req/min).

**Example cURL:**
```bash
curl -X GET "https://api.dexscreener.com/token-profiles/latest/v1"
```

**Response Shape Example:**
```json
[
  {
    "url": "https://dexscreener.com/solana/...",
    "chainId": "solana",
    "tokenAddress": "A55XjvzRU4KtR3Lrys8PpLZQvPojPqvnv5bJVHMYy3Jv",
    "icon": "https://...",
    "header": "https://...",
    "description": "Token description...",
    "links": [
      { "type": "twitter", "url": "..." },
      { "type": "telegram", "url": "..." }
    ]
  }
]
```

---

## 3. GoPlus Security API - Token Security Check
**Endpoints:**
- **Solana:** `GET https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses={addresses}`
- **EVM Chains** (e.g., Base=8453, Eth=1): `GET https://api.gopluslabs.io/api/v1/token_security/{chain_id}?contract_addresses={addresses}`

**Authentication & Headers:**
- No strictly required auth for the basic free tier usage in standard integrations, but for higher tier or custom limits, include:
  `Authorization: Bearer <your_app_key>`

**Rate Limits (Free Tier):**
- 150 Compute Units (CU) per minute.
- 30,000 CU per day.
- *Note:* Batch calls (multiple addresses in one request) are not supported on the free tier.

**Example cURL (Solana):**
```bash
curl -X GET "https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=6p6W..." -H "accept: */*"
```

**Response Shape Example (Solana):**
Contains fields checking mint and freeze authority which are critical for Solana.
```json
{
  "code": 1,
  "message": "OK",
  "result": {
    "6p6W51TAV964agHpbqtZ7hP4PAt978w1SH6fWnCypump": {
      "base_token": { "address": "...", "symbol": "SAMPLE", "decimals": 6 },
      "is_true_token": "1",
      "is_airdrop_scam": "0",
      "transfer_fee_enable": "0",
      "is_mintable": "0",
      "freezable": { "value": "0", "owner": "" },
      "transferable": "1",
      "authority": { "mint_authority": "", "freeze_authority": "" },
      "dex": [ { "name": "Raydium", "liquidity": "500000.00" } ],
      "metadata": { "mutable": "0", "update_authority": "..." },
      "trust_list": "0"
    }
  }
}
```

**Response Shape Example (EVM - e.g., Base):**
Contains fields highly specific to EVM honeypot detection.
```json
{
  "code": 1,
  "message": "OK",
  "result": {
    "0xa0b86...": {
      "is_honeypot": "0",
      "buy_tax": "0",
      "sell_tax": "0",
      "is_mintable": "1",
      "is_proxy": "1",
      "is_whitelisted": "0",
      "is_blacklisted": "0",
      "is_open_source": "1",
      "owner_address": "0x00...",
      "holder_count": "123456",
      "lp_holders": [
        { "address": "0x...", "percent": "0.45", "is_locked": 1 }
      ]
    }
  }
}
```