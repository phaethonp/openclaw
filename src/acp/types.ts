/** ACP protocol helpers and Urbicana agent identity metadata. */
import { VERSION } from "../version.js";
export { normalizeAcpProvenanceMode } from "@openclaw/acp-core/types";

/** ACP agent identity advertised during protocol initialization. */
export const ACP_AGENT_INFO = {
  name: "openclaw-acp",
  title: "Urbicana ACP Gateway",
  version: VERSION,
};
