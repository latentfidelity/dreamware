import express from 'express';
import { WebSocketServer } from 'ws';
import { createServer } from 'http';
import { query } from '@anthropic-ai/claude-agent-sdk';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// Serve static files
app.use(express.static(__dirname));

// Store active sessions
const sessions = new Map();

// System prompt for the app generator agent
const SYSTEM_PROMPT = `You are Dreamware, an expert app generator that creates beautiful, functional web applications.

When given an app description, you will:
1. First, briefly analyze what the user wants (1-2 sentences)
2. Then generate a complete, working HTML file with embedded CSS and JavaScript

IMPORTANT OUTPUT FORMAT:
- Start your code output with exactly: \`\`\`html
- End your code output with exactly: \`\`\`
- The code block must contain a complete, self-contained HTML file
- Include all CSS in a <style> tag
- Include all JavaScript in a <script> tag

DESIGN PRINCIPLES:
- Modern, clean UI with glassmorphism effects
- Smooth animations and transitions
- Mobile-responsive design
- Beautiful gradients and shadows
- Professional typography
- Dark mode friendly color schemes

TECHNICAL REQUIREMENTS:
- Pure HTML/CSS/JavaScript (no external dependencies)
- Self-contained in a single file
- Functional interactions where applicable
- Accessible and semantic HTML

Be creative and make the app visually stunning while being fully functional.`;

// Process messages from the agent and extract relevant content
function parseAgentMessage(message) {
  if (message.type === 'assistant' && message.message?.content) {
    const content = message.message.content;
    let text = '';

    for (const block of content) {
      if (block.type === 'text') {
        text += block.text;
      }
    }
    return text;
  }
  return null;
}

// Handle WebSocket connections
wss.on('connection', (ws) => {
  const sessionId = Math.random().toString(36).substring(7);
  sessions.set(sessionId, { ws, abortController: null });

  console.log(`Client connected: ${sessionId}`);

  ws.on('message', async (data) => {
    try {
      const message = JSON.parse(data.toString());

      if (message.type === 'generate') {
        await handleGenerate(sessionId, message.prompt);
      } else if (message.type === 'cancel') {
        handleCancel(sessionId);
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  });

  ws.on('close', () => {
    handleCancel(sessionId);
    sessions.delete(sessionId);
    console.log(`Client disconnected: ${sessionId}`);
  });
});

// Handle app generation request
async function handleGenerate(sessionId, prompt) {
  const session = sessions.get(sessionId);
  if (!session) return;

  const { ws } = session;
  const abortController = new AbortController();
  session.abortController = abortController;

  // Send initial status
  ws.send(JSON.stringify({ type: 'status', phase: 'connecting', message: 'Dreamware is waking up...' }));

  try {
    let fullResponse = '';
    let codeStarted = false;
    let codeContent = '';
    let lastAnalysisSent = '';

    // Start the agent query with streaming
    const agentQuery = query({
      prompt: `Create an app: ${prompt}`,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        abortController,
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        tools: [],
        includePartialMessages: true, // Enable real streaming
      }
    });

    ws.send(JSON.stringify({ type: 'status', phase: 'thinking', message: 'Dreamware is dreaming...' }));

    // Process streaming messages
    for await (const message of agentQuery) {
      if (abortController.signal.aborted) break;

      // Handle streaming partial messages (real-time token streaming)
      if (message.type === 'stream_event') {
        const event = message.event;

        if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
          const newText = event.delta.text;
          fullResponse += newText;

          // Check if we've hit the code block
          if (fullResponse.includes('```html')) {
            if (!codeStarted) {
              codeStarted = true;
              ws.send(JSON.stringify({ type: 'code_start' }));
            }

            // Extract code content
            const codeMatch = fullResponse.match(/```html\n?([\s\S]*?)(?:```|$)/);
            if (codeMatch) {
              codeContent = codeMatch[1];
              ws.send(JSON.stringify({ type: 'code', content: codeContent }));
            }
          } else {
            // Still in analysis phase - send the text as it streams
            const currentAnalysis = fullResponse.trim();
            if (currentAnalysis !== lastAnalysisSent) {
              ws.send(JSON.stringify({ type: 'analysis', content: currentAnalysis }));
              lastAnalysisSent = currentAnalysis;
            }
          }
        }
      }
      // Handle complete assistant messages (fallback)
      else if (message.type === 'assistant') {
        const text = parseAgentMessage(message);
        if (text) {
          fullResponse = text;

          // Check for code block
          const codeMatch = fullResponse.match(/```html\n?([\s\S]*?)```/);
          if (codeMatch) {
            codeContent = codeMatch[1];
            if (!codeStarted) {
              codeStarted = true;
              ws.send(JSON.stringify({ type: 'code_start' }));
            }
            ws.send(JSON.stringify({ type: 'code', content: codeContent }));
          }

          // Send analysis text (before code block)
          const analysisMatch = fullResponse.match(/^([\s\S]*?)```html/);
          if (analysisMatch && analysisMatch[1].trim()) {
            ws.send(JSON.stringify({ type: 'analysis', content: analysisMatch[1].trim() }));
          }
        }
      }
      // Handle system init message
      else if (message.type === 'system' && message.subtype === 'init') {
        ws.send(JSON.stringify({
          type: 'status',
          phase: 'generating',
          message: 'Dreamware is imagining your app...'
        }));
      }
      // Handle result
      else if (message.type === 'result') {
        ws.send(JSON.stringify({
          type: 'complete',
          code: codeContent,
          usage: message.usage,
          cost: message.total_cost_usd
        }));
      }
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      ws.send(JSON.stringify({ type: 'cancelled' }));
    } else {
      console.error('Generation error:', error);
      ws.send(JSON.stringify({ type: 'error', message: error.message }));
    }
  } finally {
    session.abortController = null;
  }
}

// Handle cancellation
function handleCancel(sessionId) {
  const session = sessions.get(sessionId);
  if (session?.abortController) {
    session.abortController.abort();
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════════════════════════╗
║                                                           ║
║   ██████╗ ██████╗ ███████╗ █████╗ ███╗   ███╗            ║
║   ██╔══██╗██╔══██╗██╔════╝██╔══██╗████╗ ████║            ║
║   ██║  ██║██████╔╝█████╗  ███████║██╔████╔██║            ║
║   ██║  ██║██╔══██╗██╔══╝  ██╔══██║██║╚██╔╝██║            ║
║   ██████╔╝██║  ██║███████╗██║  ██║██║ ╚═╝ ██║            ║
║   ╚═════╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝            ║
║                                                           ║
║   ██╗    ██╗ █████╗ ██████╗ ███████╗                     ║
║   ██║    ██║██╔══██╗██╔══██╗██╔════╝                     ║
║   ██║ █╗ ██║███████║██████╔╝█████╗                       ║
║   ██║███╗██║██╔══██║██╔══██╗██╔══╝                       ║
║   ╚███╔███╔╝██║  ██║██║  ██║███████╗                     ║
║    ╚══╝╚══╝ ╚═╝  ╚═╝╚═╝  ╚═╝╚══════╝                     ║
║                                                           ║
║   Server running on http://localhost:${PORT}               ║
║   Ready to dream up your next app...                      ║
║                                                           ║
╚═══════════════════════════════════════════════════════════╝
  `);
});
