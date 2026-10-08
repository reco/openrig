import { redactSecrets } from "./gateway/slack/message.js";
import { redactTranscriptContent } from "./transcript-redaction.js";

/** Text a human will see (a prompt line, a command to approve) with credentials masked:
 *  Slack and transcript secret patterns, NAME=value secrets and --token style flags. */
export function maskSecrets(text: string): string {
  return redactTranscriptContent(redactSecrets(text))
    .replace(/\b([A-Za-z_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|PRIVATE_?KEY)[A-Za-z_]*)=("[^"]*"|'[^']*'|\S+)/gi, "$1=[redacted]")
    .replace(/(--(?:token|password|secret|api-key)[= ])\S+/gi, "$1[redacted]");
}
