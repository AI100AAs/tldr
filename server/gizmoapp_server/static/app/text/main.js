function bootstrap() {
  const runtime = window.GizmoAppRuntime;
  if (!runtime) throw new Error("The shared app runtime did not load.");
  const config = runtime.readConfig();
  const api = config.apiBase;
  const form = document.querySelector("#repo-form");
  const urlInput = document.querySelector("#repo-url");
  const button = form.querySelector("button");
  const label = button.querySelector(".button-label");
  const loader = button.querySelector(".button-loader");
  let repository = null;
  let selectedFile = null;
  const selectedFiles = new Set();
  const expandedFolders = new Set();
  let chatHistory = [];
  const viewer = document.createElement("section");
  viewer.className = "viewer-panel";
  viewer.id = "viewer-panel";
  viewer.hidden = true;
  viewer.innerHTML = `<div class="viewer-toolbar"><div><div class="panel-label">File preview</div><code id="viewer-path">Select a file</code></div><span id="viewer-language">source</span></div><div class="code-window"><pre id="file-content"><code>Choose a file from the tree to see its contents.</code></pre></div>`;
  document.querySelector(".chat-column").prepend(viewer);

  const setBusy = (busy) => { label.hidden = busy; loader.hidden = !busy; button.disabled = busy; };
  const showError = (message) => { const error = document.querySelector("#form-error"); error.textContent = message; error.hidden = !message; };
  const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  const normalizeRepositoryUrl = (value) => {
    let input = value.trim();
    const lowerInput = input.toLowerCase();
    if (lowerInput.startsWith("github.com/")) input = input.slice(11);
    if (lowerInput.startsWith("www.github.com/")) input = input.slice(15);
    return /^https?:\/\//i.test(input) ? input : `https://github.com/${input}`;
  };
  function switchTab(tab) {
    document.querySelectorAll(".workspace-tab").forEach((button) => {
      const selected = button.dataset.tab === tab;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-selected", String(selected));
    });
    document.querySelectorAll(".tab-panel").forEach((panel) => {
      const selected = panel.id === `${tab}-tab`;
      panel.classList.toggle("is-active", selected);
      panel.hidden = !selected;
    });
  }

  async function readRepository(event) {
    event.preventDefault(); showError(""); setBusy(true);
    try {
      const response = await fetch(`${api}/repositories/analyze`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url: normalizeRepositoryUrl(urlInput.value) }) });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.errors?.[0] || "Could not read that repository.");
      repository = payload; renderRepository();
    } catch (error) { showError(error.message); } finally { setBusy(false); }
  }
  function renderRepository() {
    chatHistory = [];
    selectedFile = null;
    selectedFiles.clear();
    expandedFolders.clear();
    switchTab("architecture");
    document.querySelector("#conversation").innerHTML = `<p class="conversation-empty">Select a file, then ask what it does, where it is used, or what to watch out for.</p>`;
    document.querySelector("#workspace").hidden = false;
    document.querySelector("#repo-name").textContent = repository.name;
    const link = document.querySelector("#repo-link"); link.href = repository.url; link.textContent = repository.url.replace("https://", "").replace("http://", "").replace("www.github.com/", "").replace("github.com/", "");
     document.querySelector("#repo-summary").textContent = repository.summary;
     document.querySelector("#architecture-summary").innerHTML = renderMarkdown(repository.architectureSummary || "No architecture summary was available.");
     renderArchitectureDetails();
    document.querySelector("#repo-facts").innerHTML = [[repository.language || "Mixed", "main language"], [repository.fileCount, "files indexed"], [repository.branch, "default branch"]].map(([value, label]) => `<div><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
    document.querySelector("#entry-points").innerHTML = repository.entryPoints.map((file) => `<button class="entry-point" data-file="${escapeHtml(file.path)}"><span>${escapeHtml(file.kind)}</span><strong>${escapeHtml(file.path)}</strong></button>`).join("");
    document.querySelector("#language-list").innerHTML = (repository.languages || []).map((language) => `<div class="language-row"><span>${escapeHtml(language.name)}</span><strong>${escapeHtml(language.percent)}%</strong><i style="width:${Math.min(100, language.percent)}%"></i></div>`).join("") || `<span class="muted-detail">Language data unavailable.</span>`;
    document.querySelector("#branch-list").innerHTML = (repository.branches || []).map((branch) => `<span class="branch-chip">${escapeHtml(branch)}${branch === repository.branch ? " <b>default</b>" : ""}</span>`).join("");
    document.querySelector("#file-count").textContent = `${repository.files.length} files indexed`;
    renderFiles(repository.files); updateHistoryCount();
    document.querySelectorAll("[data-file]").forEach((item) => item.addEventListener("click", () => selectFile(item.dataset.file)));
    document.querySelector("#workspace").scrollIntoView({ behavior: "smooth", block: "start" });
  }
  function renderFiles(files) {
    const list = document.querySelector("#file-list");
    const tree = { children: new Map(), files: [] };
    files.forEach((file) => {
      let node = tree;
      file.path.split("/").forEach((part, index, parts) => {
        if (!node.children.has(part)) node.children.set(part, { name: part, children: new Map(), file: index === parts.length - 1 ? file : null });
        node = node.children.get(part);
      });
    });
    const renderNode = (node, depth, prefix) => [...node.children.values()].sort((a, b) => Boolean(b.children.size) - Boolean(a.children.size) || a.name.localeCompare(b.name)).map((child) => {
      const path = prefix ? `${prefix}/${child.name}` : child.name;
      if (child.file) return `<div class="tree-file ${selectedFile?.path === child.file.path ? "is-active" : ""}"><label class="tree-check"><input type="checkbox" data-select-file="${escapeHtml(child.file.path)}" ${selectedFiles.has(child.file.path) ? "checked" : ""} aria-label="Include ${escapeHtml(child.file.path)} in AI question"><span></span></label><button class="file-row" data-file="${escapeHtml(child.file.path)}"><span class="file-icon">${escapeHtml(child.file.extension || "·")}</span><span>${escapeHtml(child.name)}</span></button></div>`;
      const open = expandedFolders.has(path) || Boolean(document.querySelector("#file-search").value);
      return `<div class="tree-folder"><button class="folder-row" data-folder="${escapeHtml(path)}" aria-expanded="${open}"><span class="folder-chevron">${open ? "▾" : "▸"}</span><span> ${escapeHtml(child.name)}</span></button>${open ? `<div class="tree-children">${renderNode(child, depth + 1, path)}</div>` : ""}</div>`;
    }).join("");
    list.innerHTML = renderNode(tree, 0, "");
    document.querySelector("#file-empty").hidden = files.length > 0;
    list.querySelectorAll("[data-file]").forEach((item) => item.addEventListener("click", () => selectFile(item.dataset.file)));
    list.querySelectorAll("[data-folder]").forEach((item) => item.addEventListener("click", () => { const path = item.dataset.folder; expandedFolders.has(path) ? expandedFolders.delete(path) : expandedFolders.add(path); renderFiles(files); }));
    list.querySelectorAll("[data-select-file]").forEach((item) => item.addEventListener("change", () => { if (item.checked && selectedFiles.size >= 5) { item.checked = false; document.querySelector("#selection-note").textContent = "Select up to 5 files for AI context."; return; } item.checked ? selectedFiles.add(item.dataset.selectFile) : selectedFiles.delete(item.dataset.selectFile); updateSelection(); }));
    updateSelection();
  }
  function selectFile(path) {
    selectedFile = repository.files.find((file) => file.path === path); if (!selectedFile) return;
    document.querySelector("#viewer-panel").hidden = false; document.querySelector("#viewer-path").textContent = path; document.querySelector("#viewer-language").textContent = selectedFile.extension || "source";
    document.querySelector("#file-content code").textContent = "Loading file contents...";
    renderFiles(filteredFiles());
    fetch(`${api}/repositories/file`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository: repository.apiPath, file: path }) }).then(async (response) => { const payload = await response.json(); if (!response.ok) throw new Error(payload.errors?.[0] || "Could not load this file."); document.querySelector("#file-content code").innerHTML = highlight(payload.content, selectedFile.extension); }).catch((error) => { document.querySelector("#file-content code").textContent = error.message; });
     document.querySelector("#selected-file").textContent = selectedFiles.size ? `${selectedFiles.size} selected files` : path; document.querySelector("#question").focus();
     switchTab("chat");
     document.querySelector("#chat-tab").scrollIntoView({ behavior: "smooth", block: "center" });
  }
  function filteredFiles() { const query = document.querySelector("#file-search").value.toLowerCase(); return repository.files.filter((file) => file.path.toLowerCase().includes(query)); }
  function updateSelection() { document.querySelector("#selection-note").textContent = selectedFiles.size ? `${selectedFiles.size} file${selectedFiles.size === 1 ? "" : "s"} selected for AI context.` : "Select up to 5 files in the repository tree."; document.querySelector("#selected-file").textContent = selectedFiles.size ? `${selectedFiles.size} selected files` : (selectedFile?.path || "selected files"); renderContextFiles(); }
  function renderArchitectureDetails() {
    document.querySelector("#architecture-facts").innerHTML = [[repository.fileCount, "files indexed"], [repository.language || "Mixed", "primary language"], [repository.branch, "default branch"], [repository.entryPoints.length, "entry points"]].map(([value, label]) => `<div class="architecture-fact"><strong>${escapeHtml(value)}</strong><span>${escapeHtml(label)}</span></div>`).join("");
    document.querySelector("#architecture-entries").innerHTML = repository.entryPoints.map((file) => `<button class="architecture-entry" data-file="${escapeHtml(file.path)}"><span>${escapeHtml(file.kind)}</span><strong>${escapeHtml(file.path)}</strong></button>`).join("");
    document.querySelectorAll("#architecture-entries [data-file]").forEach((item) => item.addEventListener("click", () => selectFile(item.dataset.file)));
  }
  function renderContextFiles() {
    const paths = [...selectedFiles];
    document.querySelector("#context-count").textContent = `${paths.length} / 5`;
    document.querySelector("#context-files").innerHTML = paths.length ? paths.map((path) => `<div class="context-file"><span title="${escapeHtml(path)}">${escapeHtml(path)}</span><button type="button" data-remove-file="${escapeHtml(path)}" aria-label="Remove ${escapeHtml(path)}">×</button></div>`).join("") : `<p class="context-empty">No files selected yet.</p>`;
    document.querySelectorAll("[data-remove-file]").forEach((item) => item.addEventListener("click", () => { selectedFiles.delete(item.dataset.removeFile); renderFiles(filteredFiles()); }));
  }
  function highlight(content, extension = "") {
    content = String(content).slice(0, 24000);
    const language = extension.toLowerCase().replace(/^\./, "");
    const supported = ["js", "jsx", "ts", "tsx", "py", "html", "css", "json", "md", "yml", "yaml", "sql", "sh", "bash", "java", "go", "rs", "c", "cpp"];
    if (!supported.includes(language)) return escapeHtml(content);
    const keywords = /^(function|const|let|var|return|import|from|export|class|def|if|else|elif|for|while|True|False|None|async|await|new|public|private|static|interface|extends|try|catch|throw|select|from|where|join|in)$/;
    const output = [];
    let index = 0;
    const token = (className, value) => `<span class="syn-${className}">${escapeHtml(value)}</span>`;
    while (index < content.length) {
      const rest = content.slice(index);
      const comment = rest.match(/^(\/\/.*|#.*|\/\*[\s\S]*?\*\/)/);
      let string = null;
      if (rest[0] === "\"" || rest[0] === "'") {
        const quote = rest[0];
        let end = 1;
        while (end < rest.length && (rest[end] !== quote || rest[end - 1] === "\\")) end += 1;
        if (end < rest.length) string = [rest.slice(0, end + 1)];
      }
      const number = rest.match(/^\b\d+(?:\.\d+)?\b/);
      const word = rest.match(/^[A-Za-z_$][\w$]*/);
      if (comment) { output.push(token("comment", comment[0])); index += comment[0].length; }
      else if (string) { output.push(token("string", string[0])); index += string[0].length; }
      else if (number) { output.push(token("number", number[0])); index += number[0].length; }
      else if (word && keywords.test(word[0])) { output.push(token("keyword", word[0])); index += word[0].length; }
      else { output.push(escapeHtml(content[index])); index += 1; }
    }
    return output.join("");
  }
  function inlineMarkdown(value) {
    const tokens = [];
    const stash = (html) => { const marker = `MDTOKEN${tokens.length}END`; tokens.push(html); return marker; };
    let html = escapeHtml(value).replace(/\x60([^\x60]+)\x60/g, (_, code) => stash(`<code class="inline-code">${code}</code>`));
    html = html.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
    html = html.replace(/\*([^*]+)\*/g, "<em>$1</em>").replace(/_([^_]+)_/g, "<em>$1</em>");
    return html.replace(/MDTOKEN(\d+)END/g, (_, index) => tokens[Number(index)]);
  }
  function renderMarkdown(markdown) {
    const lines = String(markdown).slice(0, 32000).replace(/\r\n?/g, "\n").split("\n");
    const blocks = [];
    let index = 0;
    while (index < lines.length) {
      if (!lines[index].trim()) { index += 1; continue; }
      const trimmedLine = lines[index].trim();
      const fence = trimmedLine.startsWith("```") ? [trimmedLine, trimmedLine.slice(3).trim()] : null;
      if (fence) {
        const code = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) code.push(lines[index++]);
        if (index < lines.length) index += 1;
        blocks.push(`<pre class="markdown-code"><code>${highlight(code.join("\n"), fence[1])}</code></pre>`);
        continue;
      }
      const heading = lines[index].match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) { blocks.push(`<h${heading[1].length}>${inlineMarkdown(heading[2])}</h${heading[1].length}>`); index += 1; continue; }
      if (/^\s*>/.test(lines[index])) {
        const quote = [];
        while (index < lines.length && /^\s*>/.test(lines[index])) quote.push(lines[index++].replace(/^\s*>\s?/, ""));
        blocks.push(`<blockquote>${quote.map(inlineMarkdown).join("<br>")}</blockquote>`); continue;
      }
      if (/^\s*[-*+]/.test(lines[index]) || /^[ \t]*[0-9]+/.test(lines[index])) {
        const ordered = /^[ \t]*[0-9]+/.test(lines[index]);
        const items = [];
        while (index < lines.length && (ordered ? /^[ \t]*[0-9]+/.test(lines[index]) : /^\s*[-*+]/.test(lines[index]))) {
          items.push(lines[index++].trim().replace(ordered ? /^[^ ]+ +/ : /^[-*+] +/, ""));
        }
        blocks.push((ordered ? "<ol>" : "<ul>") + items.map((item) => "<li>" + inlineMarkdown(item) + "</li>").join("") + (ordered ? "</ol>" : "</ul>")); continue;
      }
      const paragraph = [];
      while (index < lines.length && lines[index].trim() && !lines[index].trim().startsWith("```") && !/^\s{0,3}#{1,6}\s+/.test(lines[index]) && !/^\s*>/.test(lines[index]) && !/^\s*[-*+]/.test(lines[index]) && !/^[ \t]*[0-9]+/.test(lines[index])) paragraph.push(lines[index++]);
      blocks.push("<p>" + paragraph.map(inlineMarkdown).join("<br>") + "</p>");
    }
    return blocks.join("");
  }
  function renderAnswer(element, answer) {
    try {
      element.innerHTML = renderMarkdown(answer);
    } catch (error) {
      // Keep a malformed model response visible instead of aborting the stream.
      element.textContent = String(answer);
    }
  }
  function renderAnswerAndFollow(element, answer) {
    const conversation = element.closest(".conversation");
    const wasAtBottom = conversation && conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight < 32;
    renderAnswer(element, answer);
    if (wasAtBottom) conversation.scrollTop = conversation.scrollHeight;
  }
  function scheduleAnswerRender(element, answer) {
    element._pendingAnswer = answer;
    if (element._renderTimer) return;
    element._renderTimer = setTimeout(() => {
      element._renderTimer = 0;
      renderAnswerAndFollow(element, element._pendingAnswer);
    }, 80);
  }
  async function askQuestion(event) {
    event.preventDefault();
    if (!selectedFile && !selectedFiles.size) { document.querySelector("#question").placeholder = "Select a file first"; return; }
    const input = document.querySelector("#question");
    const askButton = event.currentTarget.querySelector("button");
    const question = input.value.trim();
    if (!question) return;
    const conversation = document.querySelector("#conversation");
    askButton.disabled = true;
    conversation.innerHTML += "<div class=\"message user-message\">" + escapeHtml(question) + "</div><div class=\"message ai-message\">Thinking...</div>";
    const answerElement = conversation.lastElementChild;
    conversation.scrollTop = conversation.scrollHeight;
    input.value = "";
    let answer = "";
    const streamController = new AbortController();
    let reader;
    try {
      const files = selectedFiles.size ? [...selectedFiles] : [selectedFile.path];
      const response = await fetch(api + "/repositories/ask/stream", { method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream" }, body: JSON.stringify({ repository: repository.apiPath, files, question, history: chatHistory }), signal: streamController.signal });
      if (!response.ok) { const payload = await response.json(); throw new Error(payload.errors?.[0] || "The AI could not answer."); }
      if (!response.body) throw new Error("The AI stream is not available.");
       reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      const readWithTimeout = async () => {
        let timeout;
        try {
          return await Promise.race([
            reader.read(),
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error("The AI stream stalled. Please try again.")), 45000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      };
      const processEvent = (rawEvent) => {
        const lines = rawEvent.replaceAll("\r\n", "\n").split("\n");
        const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        if (!type || !data) return;
        let parsed;
        try { parsed = JSON.parse(data); } catch { throw new Error("The AI returned malformed stream data. Please try again."); }
       if (type === "token") {
         const token = parsed;
         if (typeof token !== "string") throw new Error("The AI returned an invalid stream token.");
         if (token.length > 32000) throw new Error("The AI returned an oversized stream token.");
           answer = (answer + token).slice(0, 32000);
           scheduleAnswerRender(answerElement, answer);
       }
        if (type === "done") {
          const completed = parsed;
          if (typeof completed !== "string") throw new Error("The AI returned an invalid answer.");
          if (!completed.trim() && !answer.trim()) throw new Error("The AI returned an empty answer.");
          finished = true;
          if (completed.trim()) answer = completed.slice(0, 32000);
          renderAnswerAndFollow(answerElement, answer);
       }
         if (type === "error") throw new Error(typeof parsed === "string" ? parsed : "The AI stream failed. Please try again.");
      };
        while (true) {
           const chunk = await readWithTimeout();
          buffer += decoder.decode(chunk.value || new Uint8Array(), { stream: !chunk.done });
         if (buffer.length > 40000) throw new Error("The AI stream was too large. Please ask a shorter question.");
         let boundary;
          while ((boundary = buffer.search(/\r?\n\r?\n/)) !== -1) {
            const separator = buffer.match(/\r?\n\r?\n/)[0];
            processEvent(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + separator.length);
          }
         if (chunk.done) break;
       }
       if (buffer.trim()) processEvent(buffer);
      if (!finished) throw new Error("The AI stream ended before the answer was complete. Please try again.");
       chatHistory.push({ question, answer, files, askedAt: new Date().toISOString() });
       updateHistoryCount();
    } catch (error) {
      streamController.abort();
      if (reader) reader.cancel().catch(() => {});
      if (!answer) {
        try {
          const fallback = await fetch(api + "/repositories/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ repository: repository.apiPath, files: selectedFiles.size ? [...selectedFiles] : [selectedFile.path], question, history: chatHistory }) });
          const payload = await fallback.json();
          if (!fallback.ok) throw new Error(payload.errors?.[0] || "The AI could not answer.");
          if (typeof payload.answer !== "string" || !payload.answer.trim()) throw new Error("The AI returned an empty answer.");
          answer = payload.answer.slice(0, 32000);
           renderAnswer(answerElement, answer);
          conversation.scrollTop = conversation.scrollHeight;
          chatHistory.push({ question, answer, files: selectedFiles.size ? [...selectedFiles] : [selectedFile.path], askedAt: new Date().toISOString() });
          updateHistoryCount();
          return;
        } catch (fallbackError) {
          answerElement.textContent = fallbackError.message;
          return;
        }
      }
          renderAnswer(answerElement, answer);
          conversation.scrollTop = conversation.scrollHeight;
      answerElement.insertAdjacentHTML("beforeend", `<p class="stream-note">${escapeHtml(error.message)}</p>`);
    } finally {
       if (answerElement._renderTimer) clearTimeout(answerElement._renderTimer);
       answerElement._renderTimer = 0;
      askButton.disabled = false;
      streamController.abort();
      if (reader) reader.cancel().catch(() => {});
    }
  }
  function updateHistoryCount() {
    const count = chatHistory.length;
    document.querySelector("#history-count").textContent = count ? `${count} question${count === 1 ? "" : "s"} in this session` : "No questions yet";
  }
  function downloadFile(filename, content, type) {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([content], { type })); link.download = filename; link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
  }
  function overviewMarkdown() {
    const languages = (repository.languages || []).map((item) => `- ${item.name}: ${item.percent}%`).join("\n");
    const branches = (repository.branches || []).map((branch) => `- ${branch}${branch === repository.branch ? " (default)" : ""}`).join("\n");
    const entries = repository.entryPoints.map((item) => `- ${item.path} (${item.kind})`).join("\n");
    return `# ${repository.name}\n\nRepository: ${repository.url}\n\n## Overview\n${repository.summary}\n\n## Facts\n- Files: ${repository.fileCount}\n- Main language: ${repository.language}\n- Default branch: ${repository.branch}\n\n## Language Breakdown\n${languages || "No language data available."}\n\n## Branches\n${branches}\n\n## Likely Entry Points\n${entries}\n`;
  }
  function architectureMarkdown() { return `# ${repository.name} architecture\n\nRepository: ${repository.url}\n\n${repository.architectureSummary || "No architecture summary was available."}\n`; }
  function chatMarkdown() {
    return `# Codeatlas chat history\n\nRepository: ${repository?.url || ""}\n\n${chatHistory.map((item, index) => `## Question ${index + 1}\n\nFiles: ${item.files.join(", ")}\n\n**You**\n\n${item.question}\n\n**AI**\n\n${item.answer}`).join("\n\n") || "No questions have been asked yet."}\n`;
  }
  const themeToggle = document.querySelector("#theme-toggle");
  themeToggle.addEventListener("click", () => {
    const dark = document.body.classList.toggle("dark-mode");
    themeToggle.setAttribute("aria-pressed", String(dark));
    themeToggle.lastChild.textContent = dark ? " Light mode" : " Dark mode";
  });
  form.addEventListener("submit", readRepository); document.querySelector("#question-form").addEventListener("submit", askQuestion);
  document.querySelectorAll(".workspace-tab").forEach((button) => button.addEventListener("click", () => switchTab(button.dataset.tab)));
  document.querySelector("#download-overview").addEventListener("click", () => { if (repository) downloadFile(`${repository.name.replaceAll("/", "-")}-overview.md`, overviewMarkdown(), "text/markdown"); });
  document.querySelector("#download-architecture").addEventListener("click", () => { if (repository) downloadFile(`${repository.name.replaceAll("/", "-")}-architecture.md`, architectureMarkdown(), "text/markdown"); });
  document.querySelector("#download-chat").addEventListener("click", () => { if (repository) downloadFile(`${repository.name.replaceAll("/", "-")}-chat-history.md`, chatMarkdown(), "text/markdown"); });
   document.querySelector("#context-add").addEventListener("click", () => document.querySelector("#file-search").focus());
  document.querySelector("#file-search").addEventListener("input", () => { if (repository) renderFiles(filteredFiles()); });
  runtime.markReady();
}
try { bootstrap(); } catch (error) { window.GizmoAppRuntime?.showFatalError(error); }
