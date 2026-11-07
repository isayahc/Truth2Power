"""Exercise the same two MCP tools as OpenCode against the live site."""
import asyncio
import json
import sys
from pathlib import Path
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client


async def call(session: ClientSession, name: str, args: dict) -> dict[str, Any]:
    """Read a structured MCP tool response and fail on tool errors."""
    result = await session.call_tool(name, args)
    if result.isError:
        raise RuntimeError(result.content[0].text)
    return json.loads(result.content[0].text)


async def main() -> None:
    """Discover English source links, verify the row, and print its saved assessment."""
    import os
    params = StdioServerParameters(command=sys.executable, args=[str(Path(__file__).with_name("server.py"))],
                                   env=dict(os.environ))
    async with stdio_client(params) as (reader, writer), ClientSession(reader, writer) as session:
        await session.initialize()
        discovery = await call(session, "discover_little_falls", {})
        def choose(term: str) -> str:
            """Require one English result for this document role."""
            matches = {link["url"] for link in discovery["links"]
                       if term in link["label"].lower() and "english" in link["label"].lower()}
            if len(matches) != 1:
                raise RuntimeError(f"Review ambiguous or missing {term} links.")
            return matches.pop()
        report = await call(session, "verify_little_falls", dict(discovery_id=discovery["id"],
                            application_url=choose("application"),policy_url=choose("charity care")))
        print(json.dumps(report, indent=2,ensure_ascii=False))


if __name__ == "__main__":
    asyncio.run(main())
