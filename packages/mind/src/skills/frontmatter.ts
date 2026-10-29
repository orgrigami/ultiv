/**
 * SKILL.md frontmatter: the agentskills.io shape (`name` and `description`
 * scalars, then a markdown body). Tolerant on purpose: quoted values, CRLF,
 * extra keys ignored. One parser for built-in and user-written skills, so
 * everything the skill list renders went through the same rules.
 */

export interface SkillDoc {
  readonly name: string;
  readonly description: string;
  readonly body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse frontmatter + body; undefined when the file is not a skill doc. */
export const parseSkillDoc = (markdown: string): SkillDoc | undefined => {
  const match = FRONTMATTER.exec(markdown);
  if (match === null) return undefined;
  const head = match[1] ?? "";
  let name: string | undefined;
  let description: string | undefined;
  for (const line of head.split(/\r?\n/)) {
    const at = line.indexOf(":");
    if (at <= 0) continue;
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^"(.*)"$/, "$1");
    if (key === "name" && name === undefined) name = value;
    if (key === "description" && description === undefined) description = value;
  }
  if (name === undefined || name === "" || description === undefined || description === "") {
    return undefined;
  }
  return { name, description, body: match[2] ?? "" };
};

/** Round-trip a parsed doc back to SKILL.md text. */
export const serializeSkillDoc = (name: string, description: string, body: string): string =>
  `---\nname: ${name}\ndescription: ${description}\n---\n\n${body.trim()}\n`;
