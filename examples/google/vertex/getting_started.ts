/**
 * Getting Started with Revenium Vertex AI Middleware
 *
 * This is the simplest example to verify your setup is working.
 * Required environment variables:
 * - GOOGLE_CLOUD_PROJECT
 * - REVENIUM_METERING_API_KEY
 * Optional:
 * - GOOGLE_CLOUD_LOCATION (defaults to us-central1)
 * - GOOGLE_APPLICATION_CREDENTIALS (path to service account JSON; Application Default Credentials are used when unset)
 */

import 'dotenv/config';
import { VertexAIController } from '@revenium/middleware/google/vertex';

async function main() {
  try {
    // Create controller (automatically uses environment variables)
    const controller = new VertexAIController();

    console.log('Testing Vertex AI with Revenium tracking...\n');

    // Simple chat completion
    const response = await controller.createChat(
      ['Please verify you are ready to assist me.'],
      'gemini-2.0-flash-001'  // model parameter is required
    );

    console.log('Response:', response.responses[0].text);
    console.log('\nUsage:', {
      totalTokens: response.responses[0].usageMetadata.totalTokenCount,
      promptTokens: response.responses[0].usageMetadata.promptTokenCount,
      candidatesTokens: response.responses[0].usageMetadata.candidatesTokenCount
    });
    console.log('\nTracking successful! Check your Revenium dashboard.');

    /* Optional metadata for advanced reporting, lineage tracking, and cost allocation

    const responseWithMetadata = await controller.createChat(
      ['Your prompt here'],
      'gemini-2.0-flash-001',  // model is required
      {
        // User identification
        subscriberId: 'user-123',
        subscriberEmail: 'user@example.com',
        subscriberCredentialName: 'api-key-prod',
        subscriberCredential: 'key-abc-123',

        // Organization & billing
        organizationName: 'my-customers-name',
        subscriptionId: 'plan-enterprise-2024',

        // Product & task tracking
        productName: 'my-product',
        taskType: 'doc-summary',
        agent: 'customer-support',

        // Session tracking
        traceId: 'session-' + Date.now(),

        // Quality metrics
        responseQualityScore: 0.95,  // 0.0-1.0 scale

        // Agentic job tracking
        agenticJobId: 'job-abc123',
        agenticJobName: 'Process Loan Application',
        agenticJobType: 'loan-processing',
        agenticJobVersion: '1.0.0'
      }
    );
    */

  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
}

main();
