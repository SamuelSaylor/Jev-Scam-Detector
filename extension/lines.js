// Turns an email body into short "lines" for Jev, and highlights flagged ones.
// Loaded before content.js; exposes a single global, JevLines.
var JevLines = (() => {
  const BLOCK = "p,div,li,td,th,blockquote,pre,h1,h2,h3,h4,h5,h6";
  // Quoted history and signatures would only add noise and cost.
  const SKIP = ".gmail_quote,.gmail_signature,.jev-ui,script,style";
  const MAX_CHARS = 500;

  const collapse = (text) => text.replace(/\s+/g, " ").trim();

  // Split one long text node at spaces so every piece fits in a line.
  function pieces(node) {
    const out = [];
    while (node.length > MAX_CHARS) {
      let cut = node.data.lastIndexOf(" ", MAX_CHARS);
      if (cut < MAX_CHARS / 2) cut = MAX_CHARS;
      const rest = node.splitText(cut);
      out.push(node);
      node = rest;
    }
    out.push(node);
    return out;
  }

  // Returns [{ text, nodes }] in reading order. Each line is the text of one
  // block element, cut into chunks of at most MAX_CHARS characters.
  function extract(root) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!node.nodeValue.trim() || !parent || parent.closest(SKIP)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const groups = new Map();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      let block = node.parentElement.closest(BLOCK);
      if (!block || !root.contains(block)) block = root;
      if (!groups.has(block)) groups.set(block, []);
      groups.get(block).push(node);
    }

    const lines = [];
    for (const nodes of groups.values()) {
      let current = { nodes: [], length: 0 };
      const flush = () => {
        const text = collapse(current.nodes.map((n) => n.data).join(" "));
        if (text.length >= 2) lines.push({ text, nodes: current.nodes });
        current = { nodes: [], length: 0 };
      };
      for (const piece of nodes.flatMap(pieces)) {
        if (current.nodes.length && current.length + piece.length > MAX_CHARS) flush();
        current.nodes.push(piece);
        current.length += piece.length;
      }
      flush();
    }
    return lines;
  }

  function highlight(line, id) {
    return line.nodes
      .filter((node) => node.parentNode)
      .map((node) => {
        const mark = document.createElement("mark");
        mark.className = "jev-flag";
        mark.dataset.jevLine = id;
        node.parentNode.insertBefore(mark, node);
        mark.appendChild(node);
        return mark;
      });
  }

  function clear(scope) {
    for (const mark of scope.querySelectorAll("mark.jev-flag")) {
      const parent = mark.parentNode;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      mark.remove();
      parent.normalize(); // re-joins the text nodes we split
    }
  }

  return { extract, highlight, clear, MAX_CHARS };
})();
