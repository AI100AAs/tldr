from __future__ import annotations

import math
import base64
import json
import re
import secrets
import sqlite3
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen
from datetime import UTC, datetime
from typing import Any

from flask import Flask, Response, current_app, g, jsonify, request, stream_with_context
from werkzeug.exceptions import BadRequest, HTTPException, RequestEntityTooLarge, UnsupportedMediaType

from .capabilities import capability_payload
from .capabilities.audio import analyze_samples
from .capabilities.mapping import openstreetmap_config
from .capabilities.ml import run_kmeans, sklearn_status
from .capabilities.optimization import nearest_neighbor_route
from .capabilities.search import search_records
from .config import scoped_path
from .db import database_readiness, fetch_sample_nodes, get_db, insert_sample_node
from .llm import CourseLLMError, ask, chat, stream_chat

HEX_COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")
SLUG_RE = re.compile(r"^[a-z0-9-]{3,40}$")
MAX_LABEL_LENGTH = 120
MAX_DESCRIPTION_LENGTH = 2_000
MAX_SEARCH_QUERY_LENGTH = 200
MAX_REPOSITORY_FILES = 500
MAX_FILE_BYTES = 24_000
MAX_CHAT_HISTORY = 8
MAX_CHAT_MESSAGE_LENGTH = 12_000
MAX_CHAT_CONTEXT_LENGTH = 24_000


def _github_request(path: str) -> Any:
    request = Request(
        f"https://api.github.com/{path.lstrip('/')}",
        headers={
            "Accept": "application/vnd.github+json",
            "User-Agent": "codeatlas-repository-reader",
            "X-GitHub-Api-Version": "2022-11-28",
        },
    )
    try:
        with urlopen(request, timeout=12) as response:
            return json.loads(response.read(MAX_FILE_BYTES * 4).decode("utf-8"))
    except HTTPError as exc:
        if exc.code == 404:
            raise ValueError(
                "GitHub could not find that repository. Check the owner/repository spelling and make sure the repository is public."
            ) from exc
        if exc.code == 403:
            raise ValueError(
                "GitHub rejected the request, usually because its public API rate limit was reached. Wait a moment and try again."
            ) from exc
        if exc.code == 401:
            raise ValueError("GitHub requires authentication for that repository. Only public repositories are supported.") from exc
        if 500 <= exc.code < 600:
            raise ValueError("GitHub is temporarily unavailable. Try again in a moment.") from exc
        raise ValueError(f"GitHub returned an unexpected error ({exc.code}). Try again shortly.") from exc
    except (URLError, TimeoutError) as exc:
        raise ValueError("Codeatlas could not connect to GitHub. Check your connection and try again.") from exc
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ValueError("GitHub returned an invalid response. Try again shortly.") from exc


def _repository_path(raw_url: Any) -> tuple[str, str, str]:
    if not isinstance(raw_url, str):
        raise ValueError("url must be a public GitHub repository URL")
    parsed = urlparse(raw_url.strip())
    if parsed.scheme not in {"http", "https"} or parsed.hostname not in {"github.com", "www.github.com"}:
        raise ValueError("Enter a public GitHub URL, such as https://github.com/owner/repository")
    parts = [part for part in parsed.path.split("/") if part]
    if len(parts) < 2 or parts[0].lower() in {"login", "settings"}:
        raise ValueError("That does not look like a GitHub repository URL")
    if len(parts) > 2:
        raise ValueError("Enter the repository URL, not a file, issues, pull request, or settings URL")
    owner, repo = parts[0], parts[1].removesuffix(".git")
    if not owner or not repo:
        raise ValueError("Enter a GitHub URL in the form https://github.com/owner/repository")
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", owner + repo):
        raise ValueError("That repository URL contains unsupported characters")
    return owner, repo, f"{owner}/{repo}"


def _file_extension(path: str) -> str:
    name = path.rsplit("/", 1)[-1]
    if "." not in name:
        return "file"
    return name.rsplit(".", 1)[-1][:6]


def _chat_messages(history: Any, prompt: str) -> list[dict[str, str]]:
    messages = [{
        "role": "system",
        "content": "Answer questions about the supplied repository files. Use the previous conversation when relevant.",
    }]
    recent_messages: list[dict[str, str]] = []
    context_length = 0
    if isinstance(history, list):
        for turn in reversed(history[-MAX_CHAT_HISTORY:]):
            if not isinstance(turn, dict):
                continue
            question, answer = turn.get("question"), turn.get("answer")
            if isinstance(question, str) and isinstance(answer, str) and question.strip() and answer.strip():
                turn_messages = [
                    {"role": "user", "content": question[:MAX_CHAT_MESSAGE_LENGTH]},
                    {"role": "assistant", "content": answer[:MAX_CHAT_MESSAGE_LENGTH]},
                ]
                turn_length = sum(len(message["content"]) for message in turn_messages)
                if recent_messages and context_length + turn_length > MAX_CHAT_CONTEXT_LENGTH:
                    break
                recent_messages[0:0] = turn_messages
                context_length += turn_length
    messages.extend(recent_messages)
    messages.append({"role": "user", "content": prompt})
    return messages


def _github_file_content(repository: str, file_path: str) -> str:
    owner, repo, api_path = _repository_path(f"https://github.com/{repository}")
    if api_path != repository or len(file_path) > 300 or ".." in file_path:
        raise ValueError("Invalid repository file")
    content_payload = _github_request(
        f"repos/{quote(owner)}/{quote(repo)}/contents/{quote(file_path, safe='/')}"
    )
    encoded = content_payload.get("content", "").replace("\n", "")
    return base64.b64decode(encoded).decode("utf-8", errors="replace")[:MAX_FILE_BYTES]


def _health_payload() -> dict[str, Any]:
    return {
        "status": "ok",
        "serverTime": datetime.now(UTC).isoformat(),
    }


def _bootstrap_payload() -> dict[str, Any]:
    return {
        "app": {
            "name": current_app.config["APP_NAME"],
            "tagline": current_app.config["APP_TAGLINE"],
            "mode": "public",
            "shell": current_app.config["APP_SHELL"],
            "shellLabel": current_app.config["APP_SHELL_LABEL"],
        },
        "health": _health_payload(),
        "availableShells": current_app.config["AVAILABLE_SHELLS"],
    }


def _api_root() -> str:
    return scoped_path(current_app.config["URL_PREFIX"], "api").rstrip("/")


def _is_json_surface() -> bool:
    api_root = _api_root()
    return (
        request.path == api_root
        or request.path.startswith(f"{api_root}/")
        or request.path.endswith("/healthz")
        or request.path.endswith("/readyz")
        or request.path in {"/healthz", "/readyz"}
    )


def _error_response(message: str, status: int):
    return jsonify({"errors": [message], "requestId": getattr(g, "request_id", None)}), status


def _json_object() -> tuple[dict[str, Any] | None, tuple[Any, int] | None]:
    if not request.is_json:
        return None, _error_response("Content-Type must be application/json", 415)
    try:
        payload = request.get_json(silent=False)
    except (BadRequest, UnsupportedMediaType):
        return None, _error_response("Request body must contain valid JSON", 400)
    if not isinstance(payload, dict):
        return None, _error_response("JSON request body must be an object", 400)
    return payload, None


def _finite_number(payload: dict[str, Any], key: str, default: float) -> float:
    value = float(payload.get(key, default))
    if not math.isfinite(value):
        raise ValueError(f"{key} must be finite")
    return value


def _normalize_payload(payload: dict[str, Any]) -> tuple[dict[str, Any], list[str]]:
    errors: list[str] = []
    raw_slug = payload.get("slug", "")
    raw_label = payload.get("label", "")
    raw_description = payload.get("description", "")
    raw_color = payload.get("accent_color", "#72d1c2")

    for name, value in (
        ("slug", raw_slug),
        ("label", raw_label),
        ("description", raw_description),
        ("accent_color", raw_color),
    ):
        if not isinstance(value, str):
            errors.append(f"{name} must be a string")

    cleaned = {
        "slug": raw_slug.strip() if isinstance(raw_slug, str) else "",
        "label": raw_label.strip() if isinstance(raw_label, str) else "",
        "description": raw_description.strip() if isinstance(raw_description, str) else "",
        "accent_color": raw_color.strip() if isinstance(raw_color, str) else "",
    }
    cleaned["description"] = cleaned["description"] or "Created through the sample API."

    if not SLUG_RE.fullmatch(cleaned["slug"]):
        errors.append("slug must be 3-40 characters of lowercase letters, digits, or hyphens")
    if len(cleaned["label"]) < 2 or len(cleaned["label"]) > MAX_LABEL_LENGTH:
        errors.append(f"label must be 2-{MAX_LABEL_LENGTH} characters")
    if len(cleaned["description"]) > MAX_DESCRIPTION_LENGTH:
        errors.append(f"description must be at most {MAX_DESCRIPTION_LENGTH} characters")
    if not HEX_COLOR_RE.fullmatch(cleaned["accent_color"]):
        errors.append("accent_color must be a 6-digit hex color like #72d1c2")

    try:
        cleaned["x"] = min(0.92, max(0.08, _finite_number(payload, "x", 0.5)))
        cleaned["y"] = min(0.92, max(0.08, _finite_number(payload, "y", 0.5)))
        cleaned["radius"] = min(0.2, max(0.06, _finite_number(payload, "radius", 0.11)))
    except (TypeError, ValueError, OverflowError):
        errors.append("x, y, and radius must be finite numbers")

    return cleaned, errors


def register_api_routes(app: Flask) -> None:
    prefix = app.config["URL_PREFIX"]
    enabled_features = frozenset(app.config["ENABLED_FEATURES"])

    @app.before_request
    def assign_request_id():
        g.request_id = secrets.token_hex(8)

    @app.after_request
    def harden_response(response):
        response.headers.setdefault("X-Request-ID", getattr(g, "request_id", ""))
        response.headers.setdefault("X-Content-Type-Options", "nosniff")
        response.headers.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
        response.headers.setdefault("Cross-Origin-Resource-Policy", "same-origin")
        return response

    @app.errorhandler(RequestEntityTooLarge)
    def request_too_large(_: RequestEntityTooLarge):
        if _is_json_surface():
            return _error_response("Request body is too large", 413)
        return "Request body is too large", 413

    @app.errorhandler(HTTPException)
    def http_error(error: HTTPException):
        if _is_json_surface():
            return _error_response(error.description or error.name, error.code or 500)
        return error

    @app.errorhandler(Exception)
    def unexpected_error(error: Exception):
        current_app.logger.exception("Unhandled request error")
        if _is_json_surface():
            return _error_response("The server could not complete the request", 500)
        return "The server could not complete the request", 500

    @app.get(scoped_path(prefix, "healthz"))
    def healthz():
        return jsonify(_health_payload())

    @app.get(scoped_path(prefix, "readyz"))
    def readyz():
        ready, detail = database_readiness(current_app.config)
        return jsonify({"status": "ready" if ready else "not-ready", **detail}), 200 if ready else 503

    @app.get(scoped_path(prefix, "api/bootstrap"))
    def bootstrap():
        return jsonify(_bootstrap_payload())

    @app.get(scoped_path(prefix, "api/capabilities"))
    def capabilities():
        api_base = scoped_path(prefix, "api").rstrip("/")
        return jsonify(capability_payload(api_base, enabled_features))

    if "search" in enabled_features:
        @app.get(scoped_path(prefix, "api/search"))
        def search():
            query = request.args.get("q", "")
            if len(query) > MAX_SEARCH_QUERY_LENGTH:
                return _error_response(f"q must be at most {MAX_SEARCH_QUERY_LENGTH} characters", 400)
            return jsonify(search_records(get_db(), query))

    if "mapping" in enabled_features:
        @app.get(scoped_path(prefix, "api/map/default"))
        def map_default():
            return jsonify(openstreetmap_config())

    if "machine-learning" in enabled_features:
        @app.get(scoped_path(prefix, "api/ml/status"))
        def ml_status():
            return jsonify(sklearn_status())

        @app.post(scoped_path(prefix, "api/ml/kmeans"))
        def ml_kmeans():
            payload, error = _json_object()
            if error:
                return error
            result, errors, status = run_kmeans(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id, **result}), status
            return jsonify(result)

    if "optimization" in enabled_features:
        @app.post(scoped_path(prefix, "api/optimize/route"))
        def optimize_route():
            payload, error = _json_object()
            if error:
                return error
            result, errors = nearest_neighbor_route(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id}), 400
            return jsonify(result)

    if "audio" in enabled_features:
        @app.post(scoped_path(prefix, "api/audio/analyze"))
        def audio_analyze():
            payload, error = _json_object()
            if error:
                return error
            result, errors = analyze_samples(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id}), 400
            return jsonify(result)

    if "sample-nodes" in enabled_features:
        @app.route(scoped_path(prefix, "api/sample-nodes"), methods=["GET", "POST"])
        def sample_nodes():
            connection = get_db()
            if request.method == "GET":
                return jsonify({"sampleNodes": fetch_sample_nodes(connection)})

            payload, error = _json_object()
            if error:
                return error
            cleaned, errors = _normalize_payload(payload)
            if errors:
                return jsonify({"errors": errors, "requestId": g.request_id}), 400

            try:
                record = insert_sample_node(connection, cleaned)
            except sqlite3.IntegrityError:
                return jsonify({"errors": ["slug already exists"], "requestId": g.request_id}), 409
            except sqlite3.OperationalError:
                current_app.logger.exception("Database write remained unavailable after retries")
                return _error_response("Database is temporarily busy; retry shortly", 503)

            return jsonify({"sampleNode": record}), 201

    @app.post(scoped_path(prefix, "api/repositories/analyze"))
    def analyze_repository():
        payload, error = _json_object()
        if error:
            return error
        try:
            owner, repo, api_path = _repository_path(payload.get("url"))
            metadata = _github_request(f"repos/{quote(owner)}/{quote(repo)}")
            tree = _github_request(f"repos/{quote(owner)}/{quote(repo)}/git/trees/{quote(metadata.get('default_branch', 'main'))}?recursive=1")
            languages = _github_request(f"repos/{quote(owner)}/{quote(repo)}/languages")
            branches = _github_request(f"repos/{quote(owner)}/{quote(repo)}/branches?per_page=100")
        except ValueError as exc:
            return _error_response(str(exc), 400)

        files = [
            {"path": item["path"], "extension": _file_extension(item["path"])}
            for item in tree.get("tree", [])
            if item.get("type") == "blob" and not item["path"].startswith((".git/", "node_modules/"))
        ][:MAX_REPOSITORY_FILES]
        language_bytes = languages if isinstance(languages, dict) else {}
        total_language_bytes = sum(value for value in language_bytes.values() if isinstance(value, int))
        language_breakdown = [
            {"name": name, "bytes": value, "percent": round(value / total_language_bytes * 100, 1) if total_language_bytes else 0}
            for name, value in sorted(language_bytes.items(), key=lambda item: item[1], reverse=True)
            if isinstance(value, int)
        ]
        language = (language_breakdown[0]["name"] if language_breakdown else metadata.get("language")) or "Mixed"
        branch_names = [
            branch.get("name") for branch in branches if isinstance(branch, dict) and isinstance(branch.get("name"), str)
        ] if isinstance(branches, list) else []
        branch_names = branch_names or [metadata.get("default_branch", "main")]
        names = ", ".join(file["path"] for file in files[:80])
        prompt = (
            "You are a careful codebase onboarding assistant. Return exactly two sections using these markers: "
            "OVERVIEW: followed by two plain sentences describing what the project is, then ARCHITECTURE: followed by "
            "markdown with exactly these headings: ## Project Purpose, ## Architecture & Structure, ## Tech Stack, "
             "## Data Flow, ## Getting Started Recommendations, ## Non-Obvious Gotchas & Best Practices. "
            "Under each heading write concise, useful bullets or paragraphs grounded only in the repository metadata and file names. "
            "Say when something is uncertain. Do not invent details or claim behavior not supported by the file names.\n"
            f"Repository: {api_path}\nDescription: {metadata.get('description') or 'none'}\n"
            f"Primary language: {language}\nLanguages: {', '.join(item['name'] for item in language_breakdown[:8]) or language}\nFiles: {names}"
        )
        try:
            generated_summary = ask(prompt, max_tokens=650)
        except CourseLLMError:
            generated_summary = metadata.get("description") or f"{repo} is a {language} repository with {len(files)} tracked files."
        summary = generated_summary
        architecture_summary = (
            "## Project Purpose\n\nPurpose could not be inferred from the available repository metadata.\n\n"
            "## Architecture & Structure\n\nThe repository contains the indexed source files listed in the overview.\n\n"
            "## Tech Stack\n\nPrimary language: " + language + ".\n\n"
            "## Data Flow\n\nVerify the runtime data flow from the identified entry points before making changes.\n\n"
            "## Getting Started Recommendations\n\nStart with the README and likely entry points, then trace imports and configuration.\n\n"
            "## Non-Obvious Gotchas & Best Practices\n\nTreat inferred behavior as unverified until confirmed in the source."
        )
        architecture_headings = ("Project Purpose", "Architecture & Structure", "Tech Stack", "Data Flow", "Getting Started Recommendations", "Non-Obvious Gotchas & Best Practices")
        if "ARCHITECTURE:" in generated_summary:
            candidate_summary, candidate_architecture = generated_summary.split("ARCHITECTURE:", 1)
            summary = candidate_summary.removeprefix("OVERVIEW:").strip()
            if all(heading in candidate_architecture for heading in architecture_headings):
                architecture_summary = candidate_architecture.strip()
        elif "Architecture:" in generated_summary:
            summary, architecture_summary = generated_summary.split("Architecture:", 1)
            summary = summary.removeprefix("Overview:").strip()
            architecture_summary = architecture_summary.strip()
        else:
            summary = generated_summary.removeprefix("OVERVIEW:").strip()
        entry_names = {"readme.md": "docs", "package.json": "config", "pyproject.toml": "config", "dockerfile": "runtime", "main.py": "entry", "app.py": "entry", "index.ts": "entry", "index.js": "entry"}
        entries = []
        for file in files:
            kind = entry_names.get(file["path"].rsplit("/", 1)[-1].lower())
            if kind:
                entries.append({"path": file["path"], "kind": kind})
        entries = entries[:5] or [{"path": file["path"], "kind": "source"} for file in files[:3]]
        return jsonify({
            "name": metadata.get("full_name", api_path), "url": metadata.get("html_url", f"https://github.com/{api_path}"),
            "apiPath": api_path, "summary": summary, "language": language, "branch": metadata.get("default_branch", "main"),
            "fileCount": len(files), "files": files, "entryPoints": entries,
            "languages": language_breakdown, "branches": branch_names, "architectureSummary": architecture_summary,
        })

    @app.post(scoped_path(prefix, "api/repositories/ask"))
    def ask_about_file():
        payload, error = _json_object()
        if error:
            return error
        question, repository = payload.get("question"), payload.get("repository")
        history = payload.get("history", [])
        raw_files = payload.get("files", payload.get("file"))
        file_paths = raw_files if isinstance(raw_files, list) else [raw_files]
        file_paths = [path.strip() for path in file_paths if isinstance(path, str) and path.strip()]
        if not isinstance(question, str) or not question.strip() or not isinstance(repository, str) or not repository.strip() or not file_paths:
            return _error_response("repository, files, and question are required", 400)
        if len(file_paths) > 5:
            return _error_response("Select at most 5 files", 400)
        try:
            _repository_path(f"https://github.com/{repository}")
            contents = [(path, _github_file_content(repository, path)) for path in file_paths]
        except (ValueError, KeyError, base64.binascii.Error) as exc:
            return _error_response(str(exc), 400)
        try:
            prompt = (
                "Explain these selected files to a developer. Be specific about their purpose, relationships, important control flow, and answer the question. "
                "If the code does not establish something, say so.\n"
                f"Repository: {repository}\nFiles: {', '.join(file_paths)}\nQuestion: {question}\n\n"
                + "\n\n".join(f"Code for {path}:\n{content}" for path, content in contents)
            )
            answer = chat(_chat_messages(history, prompt), max_tokens=4096)
        except CourseLLMError as exc:
            return _error_response(str(exc), 503)
        return jsonify({"answer": answer})

    @app.post(scoped_path(prefix, "api/repositories/ask/stream"))
    def stream_answer_about_file():
        payload, error = _json_object()
        if error:
            return error
        question, repository = payload.get("question"), payload.get("repository")
        history = payload.get("history", [])
        raw_files = payload.get("files", payload.get("file"))
        file_paths = raw_files if isinstance(raw_files, list) else [raw_files]
        file_paths = [path.strip() for path in file_paths if isinstance(path, str) and path.strip()]
        if not isinstance(question, str) or not question.strip() or not isinstance(repository, str) or not repository.strip() or not file_paths:
            return _error_response("repository, files, and question are required", 400)
        if len(file_paths) > 5:
            return _error_response("Select at most 5 files", 400)
        try:
            _repository_path(f"https://github.com/{repository}")
            contents = [(path, _github_file_content(repository, path)) for path in file_paths]
        except (ValueError, KeyError, base64.binascii.Error) as exc:
            return _error_response(str(exc), 400)
        prompt = (
            "Explain these selected files to a developer. Be specific about their purpose, relationships, important control flow, and answer the question. "
            "If the code does not establish something, say so.\n"
            f"Repository: {repository}\nFiles: {', '.join(file_paths)}\nQuestion: {question}\n\n"
            + "\n\n".join(f"Code for {path}:\n{content}" for path, content in contents)
        )

        @stream_with_context
        def events():
            try:
                answer = ""
                for text in stream_chat(_chat_messages(history, prompt), max_tokens=4096):
                    if not isinstance(text, str):
                        continue
                    remaining = 32000 - len(answer)
                    if remaining <= 0:
                        break
                    text = text[:remaining]
                    answer += text
                    yield f"event: token\ndata: {json.dumps(text)}\n\n"
                yield f"event: done\ndata: {json.dumps(answer)}\n\n"
            except CourseLLMError as exc:
                yield f"event: error\ndata: {json.dumps(str(exc))}\n\n"
            except Exception:
                current_app.logger.exception("Repository answer stream failed")
                yield f"event: error\ndata: {json.dumps('The AI stream failed before the answer was complete. Please try again.')}\n\n"

        return Response(events(), mimetype="text/event-stream", headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    @app.post(scoped_path(prefix, "api/repositories/file"))
    def read_repository_file():
        payload, error = _json_object()
        if error:
            return error
        repository, file_path = payload.get("repository"), payload.get("file")
        if not all(isinstance(value, str) and value.strip() for value in (repository, file_path)):
            return _error_response("repository and file are required", 400)
        try:
            content = _github_file_content(repository.strip(), file_path.strip())
        except (ValueError, KeyError, base64.binascii.Error) as exc:
            return _error_response(str(exc), 400)
        return jsonify({"path": file_path.strip(), "content": content})

    @app.route(
        scoped_path(prefix, "api/<path:unmatched_path>"),
        methods=["GET", "POST", "PUT", "PATCH", "DELETE"],
    )
    def unknown_api_route(unmatched_path: str):
        return _error_response(f"Unknown or disabled API route: {unmatched_path}", 404)
