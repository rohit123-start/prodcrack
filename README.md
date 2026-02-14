# ProductGPT

An AI-powered product explainer SaaS application built with Next.js App Router and TypeScript. ProductGPT reads connected repositories and allows Product Managers and Business Analysts to ask product questions in natural language and receive product-focused explanations.

## Features

- **Organization-based System**: Users belong to organizations with role-based access control
- **Repository Management**: Connect and manage multiple repositories (microservice architecture)
- **Repo Ingestion**: Admin/PM roles can trigger repository ingestion to generate product context
- **Product Context Engine**: Structured context blocks (flow, permissions, billing, feature) representing product understanding
- **AI Q&A Interface**: Chat interface for asking product questions with confidence indicators
- **Role-based Access**: Admin/PM can ingest repos, Business Analysts can ask questions
- **Security Guardrails**: AI responses focus on product behavior, not technical implementation details

## Tech Stack

- **Framework**: Next.js 14 (App Router)
- **Language**: TypeScript
- **Styling**: Tailwind CSS (Dark mode)
- **Database**: Supabase client (frontend connectivity)
- **Data Fetching**: GraphQL wrapper
- **Icons**: Lucide React

## Project Structure

```
ProdCrack/
├── app/
│   ├── api/
│   │   ├── ai/route.ts          # AI Q&A endpoint
│   │   └── ingest/route.ts      # Repository ingestion endpoint
│   ├── dashboard/               # Organization dashboard
│   ├── insights/                # AI chat interface
│   ├── login/                   # Authentication
│   ├── repositories/            # Repository management
│   ├── settings/                # User settings
│   ├── globals.css              # Global styles
│   ├── layout.tsx               # Root layout
│   └── page.tsx                 # Home/redirect page
├── components/
│   ├── ChatInterface.tsx        # Chat UI component
│   └── Sidebar.tsx              # Navigation sidebar
├── lib/
│   ├── auth.ts                  # Authentication utilities
│   ├── context-engine.ts        # Product context management
│   ├── graphql.ts               # GraphQL client wrapper
│   ├── repositories.ts          # Repository management
│   └── supabase.ts              # Supabase client
├── types/
│   └── index.ts                 # TypeScript type definitions
└── package.json
```

## Getting Started

### Prerequisites

- Node.js 18+ 
- npm or yarn

### Installation

1. Install dependencies:
```bash
npm install
```

2. Set up environment variables (optional for demo):
```bash
# .env.local
NEXT_PUBLIC_SUPABASE_URL=your_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_supabase_key
NEXT_PUBLIC_GRAPHQL_ENDPOINT=your_graphql_endpoint
```

3. Run the development server:
```bash
npm run dev
```

4. Open [http://localhost:3000](http://localhost:3000) in your browser

## Demo Users

The app includes mock users for testing:

- **Sharan** (sharan@example.com) - Admin role
  - Can ingest repositories
  - Can view all insights

- **Mohan** (mohan@example.com) - Business Analyst role
  - Can ask questions
  - Cannot trigger ingestion

## Usage

1. **Login**: Select a demo user from the login page
2. **Dashboard**: View organization overview and repository stats
3. **Repositories**: 
   - Add new repositories (simulated)
   - Ingest repositories (Admin/PM only)
4. **Insights**: Ask product questions in natural language
5. **Settings**: View account information and sign out

## API Routes

### POST `/api/ingest`
Ingests a repository and generates product context blocks.

**Request:**
```json
{
  "repositoryId": "repo_123"
}
```

**Response:**
```json
{
  "success": true,
  "message": "Repository ingested successfully",
  "contextBlocksCreated": 4
}
```

### POST `/api/ai`
Processes product questions and returns AI-powered explanations.

**Request:**
```json
{
  "question": "How does user authentication work?",
  "repositoryId": "repo_123"
}
```

**Response:**
```json
{
  "answer": "Users can sign up with email...",
  "confidence": 0.85,
  "contextBlocksUsed": ["ctx_1", "ctx_2"]
}
```

## Guardrails

The AI system includes several guardrails:

- **No Code Exposure**: AI responses never expose raw code or implementation details
- **Product Focus**: Responses focus on product behavior, flows, and user-facing features
- **Context-Based**: AI only answers using provided context blocks
- **Confidence Indicators**: Each response includes a confidence score
- **Low Confidence Handling**: When confidence is low, responses start with "Based on available context, this appears to..."
- **Role Restrictions**: Ingestion is restricted to Admin/PM roles only

## Development

### Key Features Implementation

- **Authentication**: Mock authentication using localStorage (replace with Supabase Auth in production)
- **Repository Management**: In-memory storage (replace with database in production)
- **Context Engine**: Simulated context block generation (replace with actual code analysis in production)
- **AI Responses**: Simulated AI responses (replace with actual LLM integration in production)

## License

MIT
# prodcrack
# prodcrack
