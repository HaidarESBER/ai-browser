/* Printed after `npm install ecobrowser` (a postinstall step). Console-only, cannot fail. */
const tty = process.stdout.isTTY;
const paint = (code, s) => (tty ? `\x1b[${code}m${s}\x1b[0m` : s);
const cyan = (s) => paint("36", s);
const yellow = (s) => paint("33", s);
const dim = (s) => paint("2", s);
const bold = (s) => paint("1", s);

console.log(`
  ${bold(cyan("ecobrowser"))} installed ${dim("— an AI-native browser (library + MCP server)")}

  ${yellow("Use it as an MCP server")} ${dim("(Claude Desktop / Cursor / your agent):")}
    npx ecobrowser-mcp            ${dim("# start the server")}
    npx ecobrowser-mcp --help     ${dim("# setup, tools, env vars")}

  ${yellow("Use it as a library:")}
    ${dim('import { AIBrowser } from "ecobrowser";')}

  ${dim("Docs: https://github.com/HaidarESBER/ai-browser")}
`);
