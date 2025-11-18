# Ad Statistics Monitor

A React + TypeScript application for monitoring ad statistics from AWS DynamoDB.

## Features

- Real-time monitoring of ad statistics from DynamoDB
- Beautiful, modern UI with responsive design
- Auto-refresh every 30 seconds
- Displays impressions, clicks, conversions, spend, and more
- View raw data for each statistic entry

## Prerequisites

- Node.js (v18 or higher recommended)
- AWS credentials configured (via `~/.aws/credentials` or environment variables)
- Access to DynamoDB tables containing ad statistics

## Installation

Dependencies are already installed. If you need to reinstall:

```bash
npm install
```

## Configuration

The backend server uses AWS credentials from your environment. Make sure you have:

1. AWS credentials configured (via `aws configure` or environment variables)
2. Appropriate IAM permissions to read from DynamoDB tables

You can set the AWS region via environment variable:

```bash
export AWS_REGION=us-east-1
```

Or create a `.env` file in the project root (for the backend):

```bash
AWS_REGION=us-east-1
PORT=3001
```

For the frontend, you can optionally set the API URL:

```bash
VITE_API_URL=http://localhost:3001
```

## Running the Application

### Option 1: Run both frontend and backend together (Recommended)

```bash
npm run dev:all
```

This will start:
- Backend API server on `http://localhost:3001`
- Frontend dev server on `http://localhost:5173`

### Option 2: Run separately

**Terminal 1 - Backend:**
```bash
npm run dev:server
```

**Terminal 2 - Frontend:**
```bash
npm run dev
# or
npm start
```

The application will be available at `http://localhost:5173`

## Building for Production

```bash
npm run build
```

The built files will be in the `dist` directory.

## Usage

1. Start the application
2. Enter the name of your DynamoDB table containing ad statistics
3. Click "Fetch Statistics" to load data
4. The app will automatically refresh every 30 seconds

## Data Structure

The app expects DynamoDB items with fields such as:
- `id` or `campaignId` - Identifier for the campaign/stat
- `impressions` - Number of impressions
- `clicks` - Number of clicks
- `conversions` - Number of conversions
- `spend` - Amount spent (in dollars)
- `date` - Date of the statistic
- `ctr` - Click-through rate (as decimal, e.g., 0.05 for 5%)

The app will display any fields present in your DynamoDB items.

## Technologies

- React 19
- TypeScript
- Vite
- AWS SDK v3 (DynamoDB)

## License

ISC

