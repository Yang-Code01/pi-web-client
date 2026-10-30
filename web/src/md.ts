/**
 * Tiny markdown renderer that builds DOM nodes directly.
 *
 * No innerHTML anywhere: agent output is untrusted text, and building nodes with
 * textContent keeps it inert no matter what it contains.
 */

function inlineInto(target: Node, text: string): void {
  const re = /(`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))|(https?:\/\/[^\s<]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
    const token = m[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      target.appendChild(code);
    } else if (token.startsWith("**")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      target.appendChild(strong);
    } else if (token.startsWith("[")) {
      const linkMatch = /^\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)$/.exec(token);
      if (linkMatch) {
        const a = document.createElement("a");
        a.href = linkMatch[2];
        a.target = "_blank";
        a.rel = "noreferrer";
        a.textContent = linkMatch[1];
        target.appendChild(a);
      } else {
        target.appendChild(document.createTextNode(token));
      }
    } else {
      const a = document.createElement("a");
      a.href = token;
      a.target = "_blank";
      a.rel = "noreferrer";
      a.textContent = token;
      target.appendChild(a);
    }
    last = m.index + token.length;
  }
  if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
}

export function renderMarkdown(src: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  let list: HTMLElement | null = null;
  let i = 0;

  const closeList = () => {
    list = null;
  };

  while (i < lines.length) {
    const line = lines[i];

    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      closeList();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      const pre = document.createElement("pre");
      if (fence[1]) pre.dataset.lang = fence[1];
      const code = document.createElement("code");
      code.textContent = body.join("\n");
      pre.appendChild(code);
      frag.appendChild(pre);
      continue;
    }

    if (/^\s*$/.test(line)) {
      closeList();
      i += 1;
      continue;
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const h = document.createElement(`h${Math.min(4, heading[1].length + 2)}`);
      inlineInto(h, heading[2]);
      frag.appendChild(h);
      i += 1;
      continue;
    }

    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const tag = ul ? "ul" : "ol";
      if (!list || list.tagName.toLowerCase() !== tag) {
        list = document.createElement(tag);
        frag.appendChild(list);
      }
      const li = document.createElement("li");
      inlineInto(li, (ul ?? ol)![1]);
      list.appendChild(li);
      i += 1;
      continue;
    }

    closeList();
    const p = document.createElement("p");
    inlineInto(p, line);
    frag.appendChild(p);
    i += 1;
  }

  return frag;
}
