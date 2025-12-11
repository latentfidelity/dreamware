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
  ws.send(JSON.stringify({ type: 'status', phase: 'starting', message: 'Initializing Dreamware agent...' }));

  try {
    const phases = [
      { progress: 10, message: 'Analyzing your requirements...' },
      { progress: 25, message: 'Designing component architecture...' },
      { progress: 40, message: 'Generating styles and layout...' },
      { progress: 60, message: 'Building interactive elements...' },
      { progress: 80, message: 'Optimizing and polishing...' },
    ];

    let currentPhase = 0;
    let fullResponse = '';
    let codeStarted = false;
    let codeContent = '';

    // Start the agent query
    const agentQuery = query({
      prompt: `Create an app: ${prompt}`,
      options: {
        systemPrompt: SYSTEM_PROMPT,
        abortController,
        model: 'claude-sonnet-4-20250514',
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        tools: [], // No tools needed, just generation
      }
    });

    // Process streaming messages
    for await (const message of agentQuery) {
      if (abortController.signal.aborted) break;

      // Handle different message types
      if (message.type === 'assistant') {
        const text = parseAgentMessage(message);
        if (text) {
          fullResponse = text;

          // Update progress phases based on content length
          const newPhase = Math.min(
            Math.floor((fullResponse.length / 500) * phases.length),
            phases.length - 1
          );

          if (newPhase > currentPhase) {
            currentPhase = newPhase;
            ws.send(JSON.stringify({
              type: 'status',
              phase: 'generating',
              progress: phases[currentPhase].progress,
              message: phases[currentPhase].message
            }));
          }

          // Check for code block
          const codeMatch = fullResponse.match(/```html\n?([\s\S]*?)```/);
          if (codeMatch) {
            codeContent = codeMatch[1];
            if (!codeStarted) {
              codeStarted = true;
              ws.send(JSON.stringify({ type: 'code_start' }));
            }
            ws.send(JSON.stringify({ type: 'code', content: codeContent }));
          } else if (fullResponse.includes('```html')) {
            // Code block started but not finished yet
            const partialCode = fullResponse.split('```html')[1];
            if (partialCode && !codeStarted) {
              codeStarted = true;
              ws.send(JSON.stringify({ type: 'code_start' }));
            }
            if (partialCode) {
              ws.send(JSON.stringify({ type: 'code', content: partialCode }));
              codeContent = partialCode;
            }
          }

          // Send analysis text (before code block)
          const analysisMatch = fullResponse.match(/^([\s\S]*?)```html/);
          if (analysisMatch && analysisMatch[1].trim()) {
            ws.send(JSON.stringify({ type: 'analysis', content: analysisMatch[1].trim() }));
          }
        }
      } else if (message.type === 'result') {
        // Generation complete
        ws.send(JSON.stringify({
          type: 'status',
          phase: 'complete',
          progress: 100,
          message: 'Your app is ready!'
        }));

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
