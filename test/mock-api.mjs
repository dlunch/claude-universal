// A scripted stand-in for the Anthropic Messages API. A user message containing RUN_TOOL
// gets a Bash tool call; the tool's output is echoed back in the final answer, so the reply
// proves the tool ran. Every other request gets a fixed text reply.
import http from 'node:http';

const COMMAND = 'echo tool-ran-$((6 * 7))';

function reply(request) {
  const last = request.messages.findLast((m) => m.role === 'user');
  const blocks = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : last.content;
  const result = blocks.find((block) => block.type === 'tool_result');
  if (result) {
    const output = typeof result.content === 'string'
      ? result.content
      : result.content.map((block) => block.text ?? '').join('');
    return [{ type: 'text', text: `The command printed: ${output.trim()}` }];
  }
  const asksForTool = blocks.some((block) => block.type === 'text' && block.text.includes('RUN_TOOL'));
  if (asksForTool && request.tools?.some((tool) => tool.name === 'Bash')) {
    return [
      { type: 'text', text: 'Running the command.' },
      { type: 'tool_use', id: 'toolu_mock_1', name: 'Bash', input: { command: COMMAND, description: 'Print a marker' } },
    ];
  }
  return [{ type: 'text', text: 'Hello from the mock API.' }];
}

function message(request, content) {
  return {
    id: 'msg_mock',
    type: 'message',
    role: 'assistant',
    model: request.model,
    content,
    stop_reason: content.some((block) => block.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  };
}

function stream(res, request, content) {
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
  const done = message(request, content);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  send('message_start', { message: { ...done, content: [], stop_reason: null } });
  content.forEach((block, index) => {
    if (block.type === 'text') {
      send('content_block_start', { index, content_block: { type: 'text', text: '' } });
      send('content_block_delta', { index, delta: { type: 'text_delta', text: block.text } });
    } else {
      send('content_block_start', { index, content_block: { ...block, input: {} } });
      send('content_block_delta', { index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) } });
    }
    send('content_block_stop', { index });
  });
  send('message_delta', { delta: { stop_reason: done.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } });
  send('message_stop', {});
  res.end();
}

http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => { body += chunk; });
  req.on('end', () => {
    const path = new URL(req.url, 'http://mock').pathname;
    if (req.method === 'POST' && path === '/v1/messages/count_tokens') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ input_tokens: 10 }));
    } else if (req.method === 'POST' && path === '/v1/messages') {
      const request = JSON.parse(body);
      const content = reply(request);
      if (request.stream) {
        stream(res, request, content);
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(message(request, content)));
      }
    } else {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: 'Not found' } }));
    }
  });
}).listen(8080);
