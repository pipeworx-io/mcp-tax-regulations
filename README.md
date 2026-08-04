# mcp-tax-regulations

Tax Regulations MCP — US Treasury / IRS regulations (26 CFR, "Treas. Reg.").

Part of [Pipeworx](https://pipeworx.io) — an MCP gateway connecting AI agents to 1394+ live data sources.

## Tools

| Tool | Description |
|------|-------------|
| `tax_regulation` | Get the full text of one Treasury Regulation / IRS regulation — a US federal tax regulation codified in 26 CFR — by its citation. Returns the exact regulatory wording currently in force. Answers "what does Treas. Reg. 1.170A say", "what is the IRS regulation for X", "the Treasury Regulation on X", "read 26 CFR 1.61-1", "the income tax regulation for X". Forgiving citation input: "1.170A-1", "26 CFR 1.61-1", "Treas. Reg. 1.501(c)(3)-1", "§1.170A-1", even "1.170A-1(b)" (trailing paragraph stripped). Tax citations are dotted — the part is the number BEFORE the first dot: "1.170A-1" -> part 1, section 170A-1; "301.7701-1" -> part 301. Covers 26 CFR part 1 income tax regulations (gross income, deductions, credits, charitable contributions 1.170A, exempt organizations 1.501(c)(3)-1, depreciation, capital gains), part 301 procedure & administration, parts 20 & 25 estate & gift tax, part 31 employment tax — the whole of Title 26. Pass a whole part (e.g. "1") to get a (large) section list. Example: tax_regulation({ citation: "1.170A-1" }) -> charitable contribution deduction; tax_regulation({ citation: "Treas. Reg. 1.61-1" }) -> gross income defined. Keyless. |
| `tax_search` | Keyword search across federal tax regulations — US Treasury / IRS regulations in 26 CFR. Answers "what tax regulations cover X", "the IRS regulation / Treasury Regulation about X", "find the federal tax rule for X". Great for topics: charitable contribution deduction, gross income, business expense deduction, depreciation and MACRS, capital gains and losses, section 501(c)(3) exempt organizations, S corporations, partnerships, like-kind exchanges, employment tax, estate and gift tax, foreign tax credit, retirement plans. Returns matching Treasury Regulations with citation (26 CFR / Treas. Reg.), heading, excerpt, and source URL. Example: tax_search({ query: "charitable contribution deduction" }); tax_search({ query: "depreciation", limit: 15 }). Keyless. |

## Quick Start

Add to your MCP client (Claude Desktop, Cursor, Windsurf, etc.):

```json
{
  "mcpServers": {
    "tax-regulations": {
      "url": "https://gateway.pipeworx.io/tax-regulations/mcp"
    }
  }
}
```

Or connect to the full Pipeworx gateway for access to all 1394+ data sources:

```json
{
  "mcpServers": {
    "pipeworx": {
      "url": "https://gateway.pipeworx.io/mcp"
    }
  }
}
```

## Using with ask_pipeworx

Instead of calling tools directly, you can ask questions in plain English:

```
ask_pipeworx({ question: "your question about Tax Regulations data" })
```

The gateway picks the right tool and fills the arguments automatically.

## More

- [Docs and guides](https://pipeworx.io/docs)
- [pipeworx.io](https://pipeworx.io)

## License

MIT
