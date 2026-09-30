# Pricing

export const PRICING = {
  "_meta": {
    "units": {
      "model input/output/cache": "$ per 1,000,000 tokens",
      "tools": "$ per invocation",
      "sandbox.session": "$ per session (<=20-min billing window)",
      "search.per1k": "$ per 1,000 requests",
      "sonar.input/output/citation/reasoning": "$ per 1,000,000 tokens",
      "sonar.request.{low,medium,high}": "$ per 1,000 requests (varies by search context size)",
      "sonar.searchQueries": "$ per 1,000 searches (Deep Research only)",
      "embeddings.rate": "$ per 1,000,000 tokens"
    },
  },
  "sonar": {
    "models": [{
      "id": "sonar",
      "label": "Sonar",
      "input": 1,
      "output": 1,
      "request": {
        "low": 5,
        "medium": 8,
        "high": 12
      }
    }, {
      "id": "sonar-pro",
      "label": "Sonar Pro",
      "input": 3,
      "output": 15,
      "request": {
        "low": 6,
        "medium": 10,
        "high": 14
      }
    }, {
      "id": "sonar-reasoning-pro",
      "label": "Sonar Reasoning Pro",
      "input": 2,
      "output": 8,
      "request": {
        "low": 6,
        "medium": 10,
        "high": 14
      }
    }, {
      "id": "sonar-deep-research",
      "label": "Sonar Deep Research",
      "input": 2,
      "output": 8,
      "citation": 2,
      "reasoning": 3,
      "searchQueries": 5
    }]
  },
  "embeddings": []
};
