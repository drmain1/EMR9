# AWS HealthScribe SOAP Notes Integration Plan

## Goal
To integrate AWS HealthScribe into our existing Vue.js medical system, allowing doctors to create SOAP notes via voice or text input, with the output formatted as shown in the provided artifact ([Claude Artifact](https://claude.site/artifacts/9bcd3f35-b503-4e84-937b-ef268aaf48a4)).

## Step-by-Step Plan

1. **Review AWS HealthScribe and Transcribe Medical Documentation**
   - **AWS HealthScribe**: Reviewed documentation and the [AWS HealthScribe Demo](https://github.com/aws-samples/aws-healthscribe-demo). HealthScribe is a HIPAA-eligible service that combines speech recognition and generative AI to transcribe patient-clinician conversations and generate structured clinical notes. It supports voice input for medical documentation like SOAP notes, with features like summarized notes, structured medical term extraction, and evidence mapping for validation. Available in limited AWS regions (e.g., us-east-1 as of October 2024).
   - **AWS Transcribe Medical**: Reviewed AWS documentation ([Amazon Transcribe Medical](https://docs.aws.amazon.com/transcribe/latest/dg/transcribe-medical.html)). Transcribe Medical is an automatic speech recognition (ASR) service tailored for medical professionals to transcribe medical-related speech (e.g., physician notes, telemedicine). It supports real-time streaming and batch transcription, available in US English, with best results using lossless audio formats (FLAC/WAV, 16kHz+). It operates under a shared responsibility model and is not a substitute for professional medical advice.
   - **Enhancement with Bedrock LLM**: Reviewed the [HealthScribe Enhancement Notebook](https://github.com/aws-samples/enhancing-patient-and-clinician-experiences-with-healthscribe). This provides Jupyter notebooks for using Bedrock with Anthropic models (like Claude v3 Haiku) to extend HealthScribe output into formatted clinical notes. It also integrates with Amazon Comprehend Medical for ontology linking (ICD-10-CM, SNOMED CT).
   - **Key Components Identified**:
     - **UI**: The HealthScribe demo provides a React-based interface (using Cloudscape) for recording audio and displaying transcribed notes. Components include audio recording controls and note display areas.
     - **Backend**: Utilizes AWS SDK for integration with HealthScribe and Transcribe Medical APIs for transcription. Authentication is handled via Amazon Cognito, and storage uses Amazon S3.
     - **LLM Integration**: Logic to process transcriptions through Bedrock for structured output, requiring specific IAM roles and permissions for SageMaker and HealthScribe access.
     - **Deployment**: The demo supports automatic deployment via AWS Amplify Hosting with GitHub integration or semi-automatic via AWS CodeCommit, emphasizing region-specific availability.

2. **Integrate UI Components into Vue.js App**
   - Create a new Vue component, `SOAPNoteCreator.vue`, dedicated to SOAP note creation.
   - Adapt the HealthScribe UI elements (voice recording interface, text input fields) into this component, ensuring they align with our app's design.
   - Update `App.vue` or relevant components like `PatientLookup.vue` to include or link to `SOAPNoteCreator.vue`.

3. **Set Up AWS HealthScribe for Voice Input**
   - Configure AWS HealthScribe service to process voice recordings for transcription.
   - Ensure integration with our existing AWS Cognito authentication by manually fetching session tokens and adding them to API calls, as per the memory on Amplify API authorization.
   - Implement API calls to send voice data to HealthScribe for processing.

4. **Implement Text Input Functionality**
   - Within `SOAPNoteCreator.vue`, provide a text input area for doctors who prefer typing SOAP notes.
   - Ensure the UI allows seamless switching between voice and text input modes.

5. **Integrate Bedrock LLM with Anthropic Haiku**
   - Review the logic from the [HealthScribe Enhancement Notebook](https://github.com/aws-samples/enhancing-patient-and-clinician-experiences-with-healthscribe).
   - Convert the notebook logic into a serverless architecture using AWS Lambda and API Gateway for processing transcribed text or direct text input into custom physician chart notes.
   - Use the Anthropic Haiku model for cost-effective LLM processing to format SOAP notes according to the desired output structure.

6. **Develop Lambda Functions and API Gateway Endpoints**
   - Create Lambda functions to handle:
     - Receiving voice transcription results from HealthScribe.
     - Processing text input directly from the UI.
     - Interacting with Bedrock LLM to generate formatted SOAP notes.
   - Set up API Gateway endpoints to trigger these Lambda functions, ensuring secure access with Cognito authorization headers.

7. **Testing and Validation**
   - Test voice input by recording sample SOAP notes and verifying accurate transcription and formatting.
   - Test text input by typing sample notes and ensuring they are processed correctly by the LLM.
   - Validate that the output matches the structure and style shown in the provided artifact.

8. **Update Terraform Configuration**
   - Add necessary AWS resources (if any) for HealthScribe and Bedrock integration to `main-terraform.tf`.
   - Ensure all permissions are correctly set for Lambda to access HealthScribe, Bedrock, and other required services.

9. **Documentation and Deployment**
   - Update `README.md` with instructions on using the SOAP note feature.
   - Deploy the updated application and infrastructure using Terraform, ensuring all components (UI, Lambda, API Gateway) are functioning as expected.

10. **User Feedback and Iteration**
    - Gather feedback from users (doctors) on the SOAP note creation process.
    - Iterate on the UI and backend logic based on feedback to improve usability and accuracy.

## Notes
- Ensure all API calls are authenticated properly using the method described in the memory for Amplify API calls.
- Monitor costs associated with AWS HealthScribe and Bedrock LLM usage, optimizing where possible.
- Maintain patient data security and compliance with HIPAA regulations throughout the integration.