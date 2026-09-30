// A minimal MCP Transport for a Lambda request/response cycle.
//
// The MCP SDK's built-in StreamableHTTPServerTransport is built around
// Node's http.IncomingMessage/ServerResponse (Express-style), which Lambda
// doesn't give you -- API Gateway hands the handler a parsed event object
// instead. Rather than faking a Node http req/res pair, this implements the
// SDK's much smaller Transport interface directly: start(), send(message),
// close(), plus onmessage/onclose/onerror callbacks the SDK's Server class
// calls into. That's a stable, documented seam -- the Server class itself
// still owns all the actual protocol logic (initialize handshake, tool
// listing/calling, JSON-RPC error shapes), this just wires one incoming
// message to one outgoing response.
//
// Each Lambda invocation gets its own fresh instance (see mcp-handler.js) --
// there is no session/connection state to keep between invocations, which
// matches this server being stateless (no Mcp-Session-Id is ever issued).
class LambdaTransport {
  constructor() {
    this.onmessage = undefined;
    this.onclose = undefined;
    this.onerror = undefined;
    this._pendingResolve = null;
  }

  async start() {
    // Nothing to open -- there is no persistent connection.
  }

  async close() {
    this.onclose?.();
  }

  // Called by the SDK's Server class whenever it wants to emit a message
  // (a JSON-RPC response or a server-initiated notification). For our
  // single-request-in, single-response-out use, the only one we care about
  // is the response to the message we just fed in via handle().
  async send(message) {
    if (this._pendingResolve) {
      const resolve = this._pendingResolve;
      this._pendingResolve = null;
      resolve(message);
    }
  }

  // Feeds one incoming JSON-RPC message into the server and waits for its
  // response. Requests (which carry an "id") get a response; notifications
  // (no "id", e.g. "notifications/initialized") don't, so this resolves
  // immediately with undefined for those -- callers should return an empty
  // 202 Accepted rather than a JSON-RPC response body.
  handle(message) {
    if (message.id === undefined || message.id === null) {
      this.onmessage?.(message);
      return Promise.resolve(undefined);
    }

    return new Promise((resolve) => {
      this._pendingResolve = resolve;
      this.onmessage?.(message);
    });
  }
}

module.exports = { LambdaTransport };
