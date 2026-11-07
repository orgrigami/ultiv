/**
 * The Node line Spriessen runs on: 26 (pinned in `.node-version`,
 * `mise.toml` and every manifest's `engines`). Older Node is refused: the
 * server, CLI and agent use APIs and type stripping that 26 settled. A newer
 * line still starts, with one warning, so a host upgrade never locks the
 * owner out of their own data.
 */
export const NODE_MAJOR = 26;

export type NodeVersionProblem = { readonly fatal: boolean; readonly text: string };

const majorOf = (version: string): number => Number.parseInt(version.replace(/^v/, ""), 10);

/** What is wrong with running on `version` (default: this process), or undefined. */
export const nodeVersionProblem = (
  version: string = process.versions.node,
): NodeVersionProblem | undefined => {
  const major = majorOf(version);
  if (!Number.isFinite(major)) return { fatal: true, text: `Unknown Node version "${version}".` };
  if (major < NODE_MAJOR)
    return {
      fatal: true,
      text:
        `Spriessen needs Node ${NODE_MAJOR}; this is Node ${version}. ` +
        "Run it through `vp node` (it reads .node-version) or install Node 26.",
    };
  if (major > NODE_MAJOR)
    return {
      fatal: false,
      text: `Spriessen is tested on Node ${NODE_MAJOR}; this is Node ${version}. Things may break.`,
    };
  return undefined;
};

/** Refuse to start on an old Node; warn once on a newer one. */
export const assertNodeVersion = (
  warn: (line: string) => void = (line) => console.warn(line),
): void => {
  const problem = nodeVersionProblem();
  if (problem === undefined) return;
  if (problem.fatal) throw new Error(problem.text);
  warn(problem.text);
};
