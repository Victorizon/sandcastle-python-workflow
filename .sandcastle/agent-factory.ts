/**
 * Shared Agent & Docker Sandbox Factory (`.sandcastle/agent-factory.ts`).
 *
 * Defaults to `codex` (for work environments with `~/.codex/auth.json`).
 * Switch to Claude Code on personal machines with `SANDCASTLE_AGENT=claude`
 * (uses `CLAUDE_CODE_OAUTH_TOKEN` in `.sandcastle/.env` or mounts `~/.claude/.credentials.json`).
 */

import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";

export type AgentKind = "codex" | "claude";

export function resolveAgentKind(cliArg?: string): AgentKind {
  const raw = (cliArg ?? process.env["SANDCASTLE_AGENT"] ?? "codex").trim().toLowerCase();
  return raw === "claude" || raw === "claude-code" ? "claude" : "codex";
}

export function createAgent(
  effort: "low" | "medium" | "high" = "medium",
  kind: AgentKind = resolveAgentKind(),
) {
  if (kind === "claude") {
    const claudeModel = process.env["CLAUDE_MODEL"] ?? "sonnet";
    return sandcastle.claudeCode(claudeModel, {
      effort,
      permissionMode: "bypassPermissions",
      captureSessions: true,
    });
  }
  const codexModel = process.env["CODEX_MODEL"] ?? "gpt-5.4";
  return sandcastle.codex(codexModel, {
    effort,
    approvalsReviewer: "auto_review",
    captureSessions: true,
  });
}

export function createDockerSandbox(
  imageName = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex",
  kind: AgentKind = resolveAgentKind(),
) {
  const home = process.env["HOME"] ?? os.homedir();
  const mounts: { hostPath: string; sandboxPath: string; readonly: boolean }[] = [];

  if (kind === "claude") {
    const credsPath = path.join(home, ".claude", ".credentials.json");
    if (existsSync(credsPath)) {
      mounts.push({
        hostPath: "~/.claude/.credentials.json",
        sandboxPath: "/home/agent/.claude/.credentials.json",
        readonly: true,
      });
    }
  } else {
    const authPath = path.join(home, ".codex", "auth.json");
    if (existsSync(authPath)) {
      mounts.push({
        hostPath: "~/.codex/auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
        readonly: true,
      });
    }
  }

  return docker({
    imageName,
    mounts,
  });
}
