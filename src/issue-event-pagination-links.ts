export interface IssueEventLinkMember {
  raw: string;
  target: string;
  relation: string;
}

export type IssueEventLinkResult =
  | { kind: "absent" }
  | { kind: "present"; link: string; members: IssueEventLinkMember[] };

export function parseIssueEventLink(link: unknown): IssueEventLinkResult {
  if (link === undefined || link === null) return { kind: "absent" };
  if (typeof link !== "string" || link.length === 0) invalid();

  const members: IssueEventLinkMember[] = [];
  let index = 0;
  while (true) {
    const memberStart = index;
    index = skipOws(link, index);
    if (link[index] !== "<") invalid();
    index += 1;

    const targetStart = index;
    while (index < link.length && link[index] !== ">") {
      if (!isTargetChar(link.charCodeAt(index))) invalid();
      index += 1;
    }
    if (index === targetStart || link[index] !== ">") invalid();
    const target = link.slice(targetStart, index);
    index += 1;
    index = skipOws(link, index);
    if (link[index] !== ";") invalid();
    index = skipOws(link, index + 1);
    if (link.slice(index, index + 3) !== "rel") invalid();
    index = skipOws(link, index + 3);
    if (link[index] !== "=") invalid();
    index = skipOws(link, index + 1);

    const relationStart = index;
    if (link[index] === '"') {
      index += 1;
      index = consumeRelationToken(link, index);
      if (index < 0) invalid();
      while (link[index] === " ") {
        const spaceStart = index;
        while (link[index] === " ") index += 1;
        index = consumeRelationToken(link, index);
        if (index < 0 || index === spaceStart) invalid();
      }
      if (link[index] !== '"') invalid();
      index += 1;
    } else {
      index = consumeRelationToken(link, index);
      if (index < 0) invalid();
    }

    members.push({
      raw: link.slice(memberStart, index),
      target,
      relation: link.slice(relationStart, index)
    });
    if (index === link.length) break;
    index = skipOws(link, index);
    if (link[index] !== ",") invalid();
    index += 1;
  }
  return { kind: "present", link, members };
}

function skipOws(value: string, start: number): number {
  let index = start;
  while (value[index] === " " || value[index] === "\t") index += 1;
  return index;
}

function consumeRelationToken(value: string, start: number): number {
  let index = start;
  while (index < value.length && isRelationChar(value.charCodeAt(index))) index += 1;
  return index === start ? -1 : index;
}

function isTargetChar(code: number): boolean {
  return code >= 0x21 && code <= 0x7e && code !== 0x2c && code !== 0x3c && code !== 0x3e;
}

function isRelationChar(code: number): boolean {
  return code >= 0x21 && code <= 0x7e && code !== 0x22 && code !== 0x2c && code !== 0x3b;
}

function invalid(): never {
  throw new Error("invalid issue-event Link framing");
}
