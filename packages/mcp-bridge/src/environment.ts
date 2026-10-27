/** Additional variables required by Steward connectors. The SDK supplies its
 * standard OS environment separately; never inherit the entire host environment. */
const embedding = ['MAIL_EMBED_ENDPOINT', 'MAIL_EMBED_MODEL', 'MAIL_EMBED_API_KEY', 'MAIL_EMBED_DIM', 'GATEWAY_API_KEY', 'GATEWAY_PORT'];
const variables: Record<string, string[]> = {
  'llm-wiki': ['LLM_WIKI_API_BASE_URL', 'LLM_WIKI_API_TOKEN', 'WIKI_PROJECT_PATH', 'WIKI_SOURCES_DIR', 'MAIL_PROMOTER_WIKI_SOURCES_DIR'],
  mail: [...embedding, 'MAIL_MIRROR_DIR', 'WRITE_OPS_DIR'],
  calendar: [...embedding, 'CALENDAR_INDEX_DB', 'STEWARD_CALENDAR_BRIDGE_DIR', 'WRITE_OPS_DIR'],
  contacts: [...embedding, 'CONTACTS_INDEX_DB', 'WRITE_OPS_DIR'],
  documents: [...embedding, 'DOCUMENT_EMBED_ENDPOINT', 'DOCUMENT_EMBED_MODEL', 'DOCUMENT_EMBED_API_KEY', 'DOCUMENT_EMBED_DIM',
    'DOCUMENT_EXTRACT_TIMEOUT_MS', 'DOCUMENT_WORKER_HEAP_MB', 'DOCUMENT_MAX_EXTRACTED_CHARS', 'DOCUMENT_ARCHIVE_MAX_BYTES', 'DOCUMENT_CACHE_MAX_BYTES'],
  'action-center': [...embedding, 'ACTION_CENTER_DIR', 'ACTION_CENTER_DB', 'ACTION_FLOW_EMBED_ENDPOINT', 'ACTION_FLOW_EMBED_MODEL', 'ACTION_FLOW_EMBED_API_KEY'],
  trains: ['VIAGGIATRENO_BASE_URL'],
  voice: ['STEWARD_RINGBACK_ENV', 'STEWARD_RINGBACK_RUNTIME_DIR', 'STEWARD_RINGBACK_KEYCHAIN_SERVICE', 'STEWARD_LANGUAGE_FILE'],
};

export function connectorEnvironment(server: string, source: NodeJS.ProcessEnv = process.env): Record<string, string> {
  // TZ preserves explicit civil-time configuration; NODE_PATH is needed by the
  // packaged CommonJS dependencies. No provider keys or host auth token here.
  const keys = ['TZ', 'NODE_PATH', ...(variables[server] ?? [])];
  return Object.fromEntries(keys.flatMap(key => source[key] === undefined ? [] : [[key, source[key]!]]));
}
