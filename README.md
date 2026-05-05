# pi-currency

Converts the pi footer `$0.030` cost to any currency in real time.

```bash
pi install npm:pi-currency
```

## Usage

| Command | Result |
|---------|--------|
| `/currency` | Cycle currencies |
| `/currency JPY` | Show JPY only |
| `/currency USD,CNY,JPY` | Show multiple |
| `/currency USD` | Back to default |

Supports any ISO 4217 code. Preference is saved automatically.

```
↑121k ↓23k R2.4M $0.030 CN¥0.22 7.4%/1.0M (auto)
```

Data from [open.er-api.com](https://open.er-api.com) (free, cached 30 min).
