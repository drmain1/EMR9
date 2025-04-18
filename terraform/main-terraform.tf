terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0" # Use a recent stable version
    }
  }
}

provider "aws" {
  region = "us-east-1" # Set region statically
}

# --- Data Sources ---
data "aws_availability_zones" "available" {}

data "aws_caller_identity" "current" {}

# --- Networking ---

resource "aws_vpc" "emr_vpc" {
  cidr_block           = "10.0.0.0/16" # Example CIDR block, adjust if needed
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "emr-vpc"
  }
}

# --- Subnets ---
# We'll create two public subnets in different AZs for now

resource "aws_subnet" "public_subnet_a" {
  vpc_id                  = aws_vpc.emr_vpc.id
  cidr_block              = "10.0.1.0/24" # Example CIDR, adjust if needed
  availability_zone       = data.aws_availability_zones.available.names[0]
  map_public_ip_on_launch = true # Make it a public subnet

  tags = {
    Name = "emr-public-subnet-a"
  }
}

resource "aws_subnet" "public_subnet_b" {
  vpc_id                  = aws_vpc.emr_vpc.id
  cidr_block              = "10.0.2.0/24" # Example CIDR, adjust if needed
  availability_zone       = data.aws_availability_zones.available.names[1]
  map_public_ip_on_launch = true # Make it a public subnet

  tags = {
    Name = "emr-public-subnet-b"
  }
}

# --- Internet Gateway ---

resource "aws_internet_gateway" "emr_igw" {
  vpc_id = aws_vpc.emr_vpc.id

  tags = {
    Name = "emr-igw"
  }
}

# --- Route Table for Public Subnets ---

resource "aws_route_table" "public_route_table" {
  vpc_id = aws_vpc.emr_vpc.id

  route {
    cidr_block = "0.0.0.0/0" # Route for internet traffic
    gateway_id = aws_internet_gateway.emr_igw.id
  }

  tags = {
    Name = "emr-public-route-table"
  }
}

# --- Route Table Associations ---

resource "aws_route_table_association" "public_subnet_a_assoc" {
  subnet_id      = aws_subnet.public_subnet_a.id
  route_table_id = aws_route_table.public_route_table.id
}

resource "aws_route_table_association" "public_subnet_b_assoc" {
  subnet_id      = aws_subnet.public_subnet_b.id
  route_table_id = aws_route_table.public_route_table.id
}

# --- Add Private Subnets ---

resource "aws_subnet" "private_subnet_a" {
  vpc_id            = aws_vpc.emr_vpc.id
  cidr_block        = "10.0.101.0/24" # Example CIDR, adjust if needed
  availability_zone = data.aws_availability_zones.available.names[0]

  tags = {
    Name = "emr-private-subnet-a"
  }
}

resource "aws_subnet" "private_subnet_b" {
  vpc_id            = aws_vpc.emr_vpc.id
  cidr_block        = "10.0.102.0/24" # Example CIDR, adjust if needed
  availability_zone = data.aws_availability_zones.available.names[1]

  tags = {
    Name = "emr-private-subnet-b"
  }
}

# --- NAT Gateway for Private Subnets ---
# Requires an Elastic IP

resource "aws_eip" "nat_eip" {
  domain = "vpc"

  tags = {
    Name = "emr-nat-eip"
  }
}

resource "aws_nat_gateway" "emr_nat_gw" {
  allocation_id = aws_eip.nat_eip.id
  subnet_id     = aws_subnet.public_subnet_a.id # NAT GW lives in a public subnet

  tags = {
    Name = "emr-nat-gw"
  }

  # Explicit dependency on the Internet Gateway
  depends_on = [aws_internet_gateway.emr_igw]
}

# --- Route Table for Private Subnets ---

resource "aws_route_table" "private_route_table" {
  vpc_id = aws_vpc.emr_vpc.id

  route {
    cidr_block     = "0.0.0.0/0" # Route for internet traffic
    nat_gateway_id = aws_nat_gateway.emr_nat_gw.id
  }

  tags = {
    Name = "emr-private-route-table"
  }
}

# --- Private Route Table Associations ---

resource "aws_route_table_association" "private_subnet_a_assoc" {
  subnet_id      = aws_subnet.private_subnet_a.id
  route_table_id = aws_route_table.private_route_table.id
}

resource "aws_route_table_association" "private_subnet_b_assoc" {
  subnet_id      = aws_subnet.private_subnet_b.id
  route_table_id = aws_route_table.private_route_table.id
}

# --- Cognito for Authentication ---

resource "aws_cognito_user_pool" "emr_user_pool" {
  name = "emr-user-pool"

  # Basic configuration, customize as needed (password policy, MFA, etc.)
  password_policy {
    minimum_length    = 8
    require_lowercase = true
    require_numbers   = true
    require_symbols   = false # Adjust as needed
    require_uppercase = true
  }

  auto_verified_attributes = ["email"] # Example: verify users via email

  schema {
    name                = "clinic_id"
    attribute_data_type = "String"
    mutable             = true # Allow the value to be changed
    required            = false
    string_attribute_constraints {
      # Add min_length or max_length if needed
    }
  }

  tags = {
    Name = "emr-user-pool"
  }
}

resource "aws_cognito_user_pool_client" "emr_app_client" {
  name = "emr-vue-app-client"

  user_pool_id = aws_cognito_user_pool.emr_user_pool.id

  # Settings for a web app client (no secret needed)
  generate_secret      = false
  explicit_auth_flows  = ["ALLOW_USER_SRP_AUTH", "ALLOW_REFRESH_TOKEN_AUTH"]
  prevent_user_existence_errors = "ENABLED"

  # Specify callback and logout URLs - **IMPORTANT: Update these later**
  # For development, localhost is fine, but update for deployment
  callback_urls        = ["http://localhost:5173/callback"] # Adjust port if needed
  logout_urls          = ["http://localhost:5173/logout"]

  allowed_oauth_flows_user_pool_client = true
  allowed_oauth_flows                  = ["code", "implicit"] # Common flows for web apps
  allowed_oauth_scopes                 = ["openid", "email", "profile"] # Standard scopes

  supported_identity_providers = ["COGNITO"]
}

# --- Aurora Serverless v2 PostgreSQL --- 

# 1. DB Subnet Group (using the private subnets)
resource "aws_db_subnet_group" "emr_db_subnet_group" {
  name       = "emr-db-subnet-group"
  subnet_ids = [aws_subnet.private_subnet_a.id, aws_subnet.private_subnet_b.id]

  tags = {
    Name = "emr-db-subnet-group"
  }
}

# 2. Security Group for RDS
resource "aws_security_group" "rds_sg" {
  name        = "emr-rds-sg"
  description = "Allow PostgreSQL traffic to Aurora"
  vpc_id      = aws_vpc.emr_vpc.id

  # MODIFIED Ingress Rule: Allow PostgreSQL traffic ONLY from the Lambda SG
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.lambda_sg.id] # Allow traffic from Lambda SG
  }

  # CORRECTED Ingress from SSM Bastion SG in this VPC
  ingress {
    description     = "Allow PSQL from VPC SSM Bastion SG"
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [aws_security_group.ssm_instance_sg.id] # Reference the new SG
  }

  # Allow all outbound traffic (needed for DB to potentially reach AWS services)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "emr-rds-sg"
  }
}

# 4. Aurora Serverless v2 Cluster
resource "aws_rds_cluster" "emr_aurora_cluster" {
  cluster_identifier      = "emr-aurora-cluster"
  engine                  = "aurora-postgresql"
  engine_mode             = "provisioned" # Serverless v2 uses 'provisioned' mode with scaling config
  engine_version          = "15.5"       # Specify a recent PostgreSQL-compatible version
  database_name           = "emrdb"       # Initial database name

  db_subnet_group_name    = aws_db_subnet_group.emr_db_subnet_group.name
  vpc_security_group_ids  = [aws_security_group.rds_sg.id]

  manage_master_user_password = true    # Add this line
  master_username         = "emr_admin"
  skip_final_snapshot     = true # Set to false for production

  serverlessv2_scaling_configuration {
    min_capacity = 0.5 # Minimum ACUs (Aurora Capacity Units)
    max_capacity = 2   # Maximum ACUs - Adjust based on expected load
  }

  # Enable Performance Insights (optional but recommended)
  performance_insights_enabled = true
  performance_insights_retention_period = 7 # Days

  # Backup retention period (days)
  backup_retention_period = 7 # Adjust as needed

  # Enable deletion protection in production
  # deletion_protection = true

  tags = {
    Name = "emr-aurora-cluster"
  }
}

# 5. Aurora Cluster Instance(s)
resource "aws_rds_cluster_instance" "emr_aurora_instance" {
  # You can create multiple instances by using count or for_each
  # count = 1 # Example for a single instance

  identifier           = "emr-aurora-instance-1" # Unique identifier for the instance
  cluster_identifier   = aws_rds_cluster.emr_aurora_cluster.id
  instance_class       = "db.t3.medium"  # Using db.t3.medium - CHECK AVAILABILITY/suitability
  engine               = aws_rds_cluster.emr_aurora_cluster.engine # Inherit from cluster
  engine_version       = aws_rds_cluster.emr_aurora_cluster.engine_version # Inherit from cluster
  publicly_accessible  = false # Should be false for private instances
  db_subnet_group_name = aws_db_subnet_group.emr_db_subnet_group.name # Use the same subnet group

  tags = {
    Name = "emr-aurora-instance-1"
  }

  # Ensure instance is created after the cluster is ready
  depends_on = [aws_rds_cluster.emr_aurora_cluster]
}

# --- IAM Role for Lambda Functions ---

resource "aws_iam_role" "lambda_exec_role" {
  name = "emr-lambda-execution-role"

  assume_role_policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Action = "sts:AssumeRole",
        Effect = "Allow",
        Principal = {
          Service = "lambda.amazonaws.com"
        }
      }
    ]
  })

  tags = {
    Name = "emr-lambda-execution-role"
  }
}

# Attach AWS Managed Policy for basic Lambda execution (Logs, VPC)
resource "aws_iam_role_policy_attachment" "lambda_vpc_policy" {
  role       = aws_iam_role.lambda_exec_role.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaVPCAccessExecutionRole"
}

# Policy to allow reading the DB secret
resource "aws_iam_policy" "lambda_secrets_policy" {
  name        = "emr-lambda-read-db-secret-policy"
  description = "Allow Lambda to list secrets and read the RDS-managed DB credentials secret"

  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [
      {
        Effect   = "Allow"
        Action   = [
          "secretsmanager:GetSecretValue",
          "secretsmanager:DescribeSecret" # Add permission to read tags
        ]
        Resource = "arn:aws:secretsmanager:us-east-1:${data.aws_caller_identity.current.account_id}:secret:rds!cluster-*" # Grant access based on prefix
      },
      {
        Effect   = "Allow"
        Action   = "secretsmanager:ListSecrets" # Required to list secrets to find by tag
        Resource = "*"                       # ListSecrets requires Resource: "*"
      }
    ]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_secrets_attachment" {
  role       = aws_iam_role.lambda_exec_role.name
  policy_arn = aws_iam_policy.lambda_secrets_policy.arn
}

# --- Security Group for Lambda Functions ---

resource "aws_security_group" "lambda_sg" {
  name        = "emr-lambda-sg"
  description = "Allow Lambda to connect to RDS and access internet via NAT"
  vpc_id      = aws_vpc.emr_vpc.id

  # Allow all outbound traffic (Lambda needs this to talk to RDS, Secrets Mgr, NAT GW etc.)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "emr-lambda-sg"
  }
}

# --- API Gateway (v1 REST API) ---

resource "aws_api_gateway_rest_api" "emr_api" {
  name        = "emr-api"
  description = "API for EMR system"

  endpoint_configuration {
    types = ["REGIONAL"]
  }
}

# --- Lambda Function (Placeholder) ---
# NOTE: You will need to create a deployment package (e.g., index.zip) containing your Lambda code.

data "archive_file" "lambda_zip" {
  type        = "zip"
  source_dir  = "${path.module}/../lambda_code" # Point to the lambda_code directory relative to terraform dir
  output_path = "${path.module}/lambda_function.zip"
}

resource "aws_lambda_function" "emr_backend" {
  filename      = data.archive_file.lambda_zip.output_path
  function_name = "emr-backend-lambda"
  role          = aws_iam_role.lambda_exec_role.arn
  handler       = "index.handler"
  runtime       = "nodejs18.x"
  source_code_hash = data.archive_file.lambda_zip.output_base64sha256
  timeout       = 30 # seconds

  vpc_config {
    subnet_ids         = [aws_subnet.private_subnet_a.id, aws_subnet.private_subnet_b.id]
    security_group_ids = [aws_security_group.lambda_sg.id]
  }

  environment {
    variables = {
      DB_CLUSTER_IDENTIFIER = aws_rds_cluster.emr_aurora_cluster.cluster_identifier
      # DB_SECRET_ARN         = aws_secretsmanager_secret_version.db_credentials_version.arn # This is now discovered dynamically
      COGNITO_USER_POOL_ID  = aws_cognito_user_pool.emr_user_pool.id
      DB_CLUSTER_ENDPOINT   = aws_rds_cluster.emr_aurora_cluster.endpoint
      DB_NAME               = "emrdb" # Explicitly set the database name
    }
  }

  publish = true # Required for creating alias/versions if needed later
}

# --- API Gateway Integration with Lambda ---

# Proxy Resource
resource "aws_api_gateway_resource" "proxy" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  parent_id   = aws_api_gateway_rest_api.emr_api.root_resource_id
  path_part   = "{proxy+}" # Catch-all proxy path
}

# ANY Method for Proxy Resource
resource "aws_api_gateway_method" "proxy_any" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "ANY"
  authorization = "COGNITO_USER_POOLS" # Secure this endpoint
  authorizer_id = aws_api_gateway_authorizer.cognito_auth.id # Link to the new authorizer
}

# Integration between ANY method and Lambda
resource "aws_api_gateway_integration" "lambda_integration" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_any.http_method

  integration_http_method = "POST" # Always POST for Lambda proxy integration
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.emr_backend.invoke_arn
}

# Also need integration for the root path if desired (e.g., health check)
resource "aws_api_gateway_method" "root_any" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_rest_api.emr_api.root_resource_id
  http_method   = "ANY"
  authorization = "NONE" # Keep root unsecured for now
}

resource "aws_api_gateway_integration" "root_lambda_integration" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_rest_api.emr_api.root_resource_id
  http_method = aws_api_gateway_method.root_any.http_method

  integration_http_method = "POST"
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.emr_backend.invoke_arn
}

# --- Explicit OPTIONS Method for CORS Preflight on Proxy Path ---
resource "aws_api_gateway_method" "proxy_options" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "OPTIONS"
  authorization = "NONE" # IMPORTANT: No authorization for OPTIONS
}

resource "aws_api_gateway_integration" "proxy_options_integration" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_options.http_method
  type        = "MOCK" # Use MOCK integration for OPTIONS
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "proxy_options_200" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_options.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true,
    "method.response.header.Access-Control-Allow-Methods" = true,
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
  response_models = {
    "application/json" = "Empty" # Use the built-in Empty model
  }
}

resource "aws_api_gateway_integration_response" "proxy_options_integration_response" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_options.http_method
  status_code = aws_api_gateway_method_response.proxy_options_200.status_code
  response_parameters = {
    # Define the actual CORS header values returned by the MOCK integration
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'", # Match headers your frontend sends
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET,PUT,POST,DELETE'",                                      # Match methods used by your API
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"                                                                      # Be more specific in production (e.g., 'http://localhost:5173')
  }
  response_templates = {
    "application/json" = "" # Empty body for OPTIONS response
  }
  depends_on = [aws_api_gateway_integration.proxy_options_integration]
}

# --- GET Method for /patients --- 

# Method for GET requests on the proxy resource (e.g., GET /patients)
resource "aws_api_gateway_method" "proxy_get" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.proxy.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito_auth.id

  # Enable parameter mapping for query strings
  request_parameters = {
     "method.request.querystring.firstName" = false,
     "method.request.querystring.lastName" = false,
     "method.request.querystring.dateOfBirth" = false,
     "method.request.querystring.phoneNumber" = false
  }
}

# Integration for the GET method pointing to the Lambda function
resource "aws_api_gateway_integration" "lambda_integration_get" {
  rest_api_id             = aws_api_gateway_rest_api.emr_api.id
  resource_id             = aws_api_gateway_resource.proxy.id
  http_method             = aws_api_gateway_method.proxy_get.http_method
  integration_http_method = "POST" # Lambda integrations always use POST
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.emr_backend.invoke_arn
}

# Allow API Gateway to invoke the Lambda function for the GET method
resource "aws_lambda_permission" "api_gateway_permission_get" {
  statement_id  = "AllowAPIGatewayInvokeGET"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.emr_backend.function_name
  principal     = "apigateway.amazonaws.com"

  # The /*/* portion grants access from any method on any resource within the API
  # Adjust if more granular control is needed, but for proxy this is typical
  source_arn = "${aws_api_gateway_rest_api.emr_api.execution_arn}/*/${aws_api_gateway_method.proxy_get.http_method}${aws_api_gateway_resource.proxy.path}"
}

# Method response for GET 200 OK
resource "aws_api_gateway_method_response" "proxy_get_200" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_get.http_method
  status_code = "200"

  response_models = {
    "application/json" = "Empty" # Assuming the response body structure is handled by Lambda proxy integration
  }
  # Allow CORS headers to be returned
  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin" = true
  }
}

# Integration response for GET 200 OK
resource "aws_api_gateway_integration_response" "lambda_integration_get_response" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.proxy.id
  http_method = aws_api_gateway_method.proxy_get.http_method
  status_code = aws_api_gateway_method_response.proxy_get_200.status_code

  # Define how the Lambda output maps to the HTTP response
  # For standard proxy integration, often no explicit mapping is needed
  # Ensure CORS headers are passed through from Lambda or added here if needed
  response_parameters = {
      "method.response.header.Access-Control-Allow-Origin" = "'*'" # Or your specific frontend origin
  }

  # If Lambda doesn't set Content-Type, you might need a template:
  # response_templates = {
  #   "application/json" = ""
  # }
}

# --- API Gateway Deployment and Stage ---

resource "aws_api_gateway_deployment" "emr_api_deployment" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id

  triggers = {
    # Redeploy whenever the REST API changes
    redeployment = sha1(jsonencode([
      aws_api_gateway_rest_api.emr_api.body,
      # Include all method/integration resources here to trigger redeployment on changes
      aws_api_gateway_method.root_any.id,
      aws_api_gateway_integration.root_lambda_integration.id,
      aws_api_gateway_method.proxy_any.id,
      aws_api_gateway_integration.lambda_integration.id, # Corrected name
      aws_api_gateway_method.proxy_get.id,
      aws_api_gateway_integration.lambda_integration_get.id,
      aws_api_gateway_method.proxy_options.id,
      aws_api_gateway_integration.proxy_options_integration.id,
      aws_api_gateway_method.queue_post.id,
      aws_api_gateway_integration.lambda_integration_queue_post.id,
      aws_api_gateway_method.queue_options.id,
      aws_api_gateway_integration.queue_options_integration.id,
      # Include the new DELETE method resources
      aws_api_gateway_method.queue_entry_delete_method.id,
      aws_api_gateway_integration.queue_entry_delete_integration.id,
      aws_api_gateway_method.queue_entry_options_method.id,
      aws_api_gateway_integration.queue_entry_options_integration.id,
      # Add a timestamp to force redeployment
      formatdate("YYYYMMDDhhmmss", timestamp()) 
    ]))
  }

  lifecycle {
    create_before_destroy = true
  }
}

resource "aws_api_gateway_stage" "dev" {
  deployment_id = aws_api_gateway_deployment.emr_api_deployment.id
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  stage_name    = "dev" # Stage name (e.g., dev, staging, prod)
}

# --- Lambda Permission for API Gateway ---

resource "aws_lambda_permission" "api_gateway_permission" {
  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.emr_backend.function_name
  principal     = "apigateway.amazonaws.com"

  # Restrict permission to the specific API Gateway ARN
  source_arn = "${aws_api_gateway_rest_api.emr_api.execution_arn}/*/*"
}

# --- API Gateway Cognito Authorizer ---
resource "aws_api_gateway_authorizer" "cognito_auth" {
  name                   = "emr-cognito-authorizer"
  type                   = "COGNITO_USER_POOLS"
  rest_api_id            = aws_api_gateway_rest_api.emr_api.id
  provider_arns        = [aws_cognito_user_pool.emr_user_pool.arn]
  identity_source        = "method.request.header.Authorization" # Standard location for JWT
}

# --- SSM Bastion Instance (Optional) ---

# 1. IAM Role for EC2 Instance to allow SSM connection
resource "aws_iam_role" "ssm_instance_role" {
  name = "emr-ssm-instance-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Action = "sts:AssumeRole"
        Effect = "Allow"
        Principal = {
          Service = "ec2.amazonaws.com"
        }
      },
    ]
  })

  tags = {
    Name = "emr-ssm-instance-role"
  }
}

resource "aws_iam_role_policy_attachment" "ssm_managed_policy_attachment" {
  role       = aws_iam_role.ssm_instance_role.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

# Need an instance profile for EC2
resource "aws_iam_instance_profile" "ssm_instance_profile" {
  name = "emr-ssm-instance-profile"
  role = aws_iam_role.ssm_instance_role.name
}

# 2. Security Group for the SSM EC2 Instance
resource "aws_security_group" "ssm_instance_sg" {
  name        = "emr-ssm-instance-sg"
  description = "Security group for the SSM bastion instance"
  vpc_id      = aws_vpc.emr_vpc.id

  # No ingress needed for SSM itself (uses outbound connections)
  # Allow all outbound traffic for simplicity (needed for SSM agent, OS updates, etc.)
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = {
    Name = "emr-ssm-instance-sg"
  }
}

# 3. Data source to find the latest Amazon Linux 2 AMI
data "aws_ami" "amazon_linux_2" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["amzn2-ami-hvm-*-x86_64-gp2"]
  }

  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

# 4. EC2 Instance
resource "aws_instance" "ssm_bastion" {
  ami           = data.aws_ami.amazon_linux_2.id
  instance_type = "t3.micro" # Small instance type for bastion

  # Place in a public subnet to easily reach SSM endpoints via IGW
  subnet_id = aws_subnet.public_subnet_a.id

  # Assign the IAM role via instance profile
  iam_instance_profile = aws_iam_instance_profile.ssm_instance_profile.name

  # Assign the security group
  vpc_security_group_ids = [aws_security_group.ssm_instance_sg.id]

  # No key pair needed as we'll connect via SSM

  tags = {
    Name = "emr-ssm-bastion"
  }

  # Ensure dependencies are created first
  depends_on = [
    aws_internet_gateway.emr_igw,
    aws_iam_instance_profile.ssm_instance_profile,
  ]
}

# --- Outputs ---

output "api_invoke_url" {
  description = "The invoke URL for the API Gateway stage"
  value       = aws_api_gateway_stage.dev.invoke_url
}

output "cognito_user_pool_id" {
  description = "The ID of the Cognito User Pool"
  value       = aws_cognito_user_pool.emr_user_pool.id
}

output "cognito_app_client_id" {
  description = "The ID of the Cognito User Pool Client"
  value       = aws_cognito_user_pool_client.emr_app_client.id
}

output "db_cluster_endpoint" {
  description = "Endpoint address for the Aurora cluster"
  value       = aws_rds_cluster.emr_aurora_cluster.endpoint
}

output "aws_region" {
  description = "AWS region where resources are deployed"
  value       = "us-east-1"
}

# --- /queue Path --- 

# Resource for the /queue path
resource "aws_api_gateway_resource" "queue_resource" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  parent_id   = aws_api_gateway_rest_api.emr_api.root_resource_id
  path_part   = "queue"
}

# Method for POST requests on /queue
resource "aws_api_gateway_method" "queue_post" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.queue_resource.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito_auth.id
  # No request parameters needed for POST body typically
}

# Integration for POST /queue pointing to Lambda
resource "aws_api_gateway_integration" "lambda_integration_queue_post" {
  rest_api_id             = aws_api_gateway_rest_api.emr_api.id
  resource_id             = aws_api_gateway_resource.queue_resource.id
  http_method             = aws_api_gateway_method.queue_post.http_method
  integration_http_method = "POST" # Lambda integrations always use POST
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.emr_backend.invoke_arn
}

# Allow API Gateway to invoke Lambda for POST /queue
resource "aws_lambda_permission" "api_gateway_permission_queue_post" {
  statement_id  = "AllowAPIGatewayInvokeQueuePOST"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.emr_backend.function_name
  principal     = "apigateway.amazonaws.com"

  # Needs the specific ARN format for the method/resource
  source_arn    = "${aws_api_gateway_rest_api.emr_api.execution_arn}/*/${aws_api_gateway_method.queue_post.http_method}${aws_api_gateway_resource.queue_resource.path}"
}

# Method response for POST 201 Created
resource "aws_api_gateway_method_response" "queue_post_201" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_resource.id
  http_method = aws_api_gateway_method.queue_post.http_method
  status_code = "201"
  response_models = {
    "application/json" = "Empty"
  }
  response_parameters = {
    "method.response.header.Access-Control-Allow-Origin" = true
  }
}

# Integration response for POST 201 Created
resource "aws_api_gateway_integration_response" "lambda_integration_queue_post_response_201" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_resource.id
  http_method = aws_api_gateway_method.queue_post.http_method
  status_code = aws_api_gateway_method_response.queue_post_201.status_code
  response_parameters = {
      "method.response.header.Access-Control-Allow-Origin" = "'*'"
  }
}

# Need to also add OPTIONS method for /queue for CORS preflight
resource "aws_api_gateway_method" "queue_options" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.queue_resource.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "queue_options_integration" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_resource.id
  http_method = aws_api_gateway_method.queue_options.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "queue_options_200" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_resource.id
  http_method = aws_api_gateway_method.queue_options.http_method
  status_code = "200"
  response_models = {
    "application/json" = "Empty"
  }
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true,
    "method.response.header.Access-Control-Allow-Methods" = true,
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
}

resource "aws_api_gateway_integration_response" "queue_options_integration_response" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_resource.id
  http_method = aws_api_gateway_method.queue_options.http_method
  status_code = aws_api_gateway_method_response.queue_options_200.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,POST,GET'", # Adjust allowed methods for /queue
    "method.response.header.Access-Control-Allow-Origin"  = "'*'"
  }
  response_templates = {
    "application/json" = ""
  }
  depends_on = [aws_api_gateway_integration.queue_options_integration]
}

# --- Resource for /queue/{queue_entry_id} Path Parameter ---
resource "aws_api_gateway_resource" "queue_entry_resource" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  parent_id   = aws_api_gateway_resource.queue_resource.id # Assumes queue_resource is defined above
  path_part   = "{queue_entry_id}"                          # Parameterized path part
}

# --- DELETE Method for /queue/{queue_entry_id} ---
resource "aws_api_gateway_method" "queue_entry_delete_method" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.queue_entry_resource.id
  http_method   = "DELETE"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito_auth.id
}

resource "aws_api_gateway_integration" "queue_entry_delete_integration" {
  rest_api_id             = aws_api_gateway_rest_api.emr_api.id
  resource_id             = aws_api_gateway_resource.queue_entry_resource.id
  http_method             = aws_api_gateway_method.queue_entry_delete_method.http_method
  integration_http_method = "POST" # Lambda integrations always use POST
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.emr_backend.invoke_arn
}

# Allow API Gateway to invoke Lambda for DELETE /queue/{queue_entry_id}
resource "aws_lambda_permission" "api_gateway_permission_queue_delete" {
  statement_id  = "AllowAPIGatewayInvokeQueueDelete"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.emr_backend.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_api_gateway_rest_api.emr_api.execution_arn}/*/${aws_api_gateway_method.queue_entry_delete_method.http_method}${aws_api_gateway_resource.queue_entry_resource.path}"
}

# --- OPTIONS Method for /queue/{queue_entry_id} (CORS Preflight) ---
resource "aws_api_gateway_method" "queue_entry_options_method" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.queue_entry_resource.id
  http_method   = "OPTIONS"
  authorization = "NONE"
}

resource "aws_api_gateway_integration" "queue_entry_options_integration" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_entry_resource.id
  http_method = aws_api_gateway_method.queue_entry_options_method.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

resource "aws_api_gateway_method_response" "queue_entry_options_200" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_entry_resource.id
  http_method = aws_api_gateway_method.queue_entry_options_method.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true,
    "method.response.header.Access-Control-Allow-Methods" = true,
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
  response_models = {
    "application/json" = "Empty"
  }
}

resource "aws_api_gateway_integration_response" "queue_entry_options_integration_response" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.queue_entry_resource.id
  http_method = aws_api_gateway_method.queue_entry_options_method.http_method
  status_code = aws_api_gateway_method_response.queue_entry_options_200.status_code
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,DELETE'", # Add other methods on this path if needed
    "method.response.header.Access-Control-Allow-Origin"  = "'*'" # Be more specific in production
  }
  response_templates = {
    "application/json" = ""
  }
  depends_on = [aws_api_gateway_integration.queue_entry_options_integration]
}

# --- Resource for /soapnotes Path ---
resource "aws_api_gateway_resource" "soapnotes_resource" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  parent_id   = aws_api_gateway_rest_api.emr_api.root_resource_id
  path_part   = "soapnotes" # The path part for SOAP notes
}

# --- POST Method for /soapnotes ---
resource "aws_api_gateway_method" "soapnotes_post_method" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.soapnotes_resource.id
  http_method   = "POST"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito_auth.id
}

# --- Integration for POST /soapnotes with Lambda ---
resource "aws_api_gateway_integration" "soapnotes_post_integration" {
  rest_api_id             = aws_api_gateway_rest_api.emr_api.id
  resource_id             = aws_api_gateway_resource.soapnotes_resource.id
  http_method             = aws_api_gateway_method.soapnotes_post_method.http_method
  integration_http_method = "POST" # Lambda integrations always use POST
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.emr_backend.invoke_arn
}

# --- Lambda Permission for POST /soapnotes ---
# Allow API Gateway to invoke Lambda for POST /soapnotes
resource "aws_lambda_permission" "api_gateway_permission_soapnotes_post" {
  statement_id  = "AllowAPIGatewayInvokeSOAPNotesPost"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.emr_backend.function_name
  principal     = "apigateway.amazonaws.com"
  # Needs the specific ARN format for the method/resource
  source_arn    = "${aws_api_gateway_rest_api.emr_api.execution_arn}/*/${aws_api_gateway_method.soapnotes_post_method.http_method}${aws_api_gateway_resource.soapnotes_resource.path}"
}

# --- OPTIONS Method for /soapnotes (CORS Preflight) ---
resource "aws_api_gateway_method" "soapnotes_options_method" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.soapnotes_resource.id
  http_method   = "OPTIONS"
  authorization = "NONE" # OPTIONS requests are not authenticated
}

# --- Integration for OPTIONS /soapnotes (MOCK) ---
resource "aws_api_gateway_integration" "soapnotes_options_integration" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.soapnotes_resource.id
  http_method = aws_api_gateway_method.soapnotes_options_method.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

# --- Method Response for OPTIONS /soapnotes (200 OK) ---
resource "aws_api_gateway_method_response" "soapnotes_options_200" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.soapnotes_resource.id
  http_method = aws_api_gateway_method.soapnotes_options_method.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true,
    "method.response.header.Access-Control-Allow-Methods" = true,
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
  response_models = {
    "application/json" = "Empty" # No body for OPTIONS response
  }
}

# --- Integration Response for OPTIONS /soapnotes ---
resource "aws_api_gateway_integration_response" "soapnotes_options_integration_response" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.soapnotes_resource.id
  http_method = aws_api_gateway_method.soapnotes_options_method.http_method
  status_code = aws_api_gateway_method_response.soapnotes_options_200.status_code
  # Define CORS headers
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,POST'", # Allow POST requests
    "method.response.header.Access-Control-Allow-Origin"  = "'*'" # Be more specific in production if needed
  }
  response_templates = {
    "application/json" = "" # Empty body for OPTIONS response
  }
  depends_on = [aws_api_gateway_integration.soapnotes_options_integration]
}

# --- API Gateway Resources for /notes endpoint ---

# --- Resource for /notes path ---
resource "aws_api_gateway_resource" "notes_resource" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  parent_id   = aws_api_gateway_rest_api.emr_api.root_resource_id
  path_part   = "notes" # The path part for fetching notes
}

# --- GET Method for /notes ---
resource "aws_api_gateway_method" "notes_get_method" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.notes_resource.id
  http_method   = "GET"
  authorization = "COGNITO_USER_POOLS"
  authorizer_id = aws_api_gateway_authorizer.cognito_auth.id
}

# --- Integration for GET /notes with Lambda ---
resource "aws_api_gateway_integration" "notes_get_integration" {
  rest_api_id             = aws_api_gateway_rest_api.emr_api.id
  resource_id             = aws_api_gateway_resource.notes_resource.id
  http_method             = aws_api_gateway_method.notes_get_method.http_method
  integration_http_method = "POST" # Lambda integrations always use POST
  type                    = "AWS_PROXY"
  uri                     = aws_lambda_function.emr_backend.invoke_arn
}

# --- Lambda Permission for GET /notes ---
# Allow API Gateway to invoke Lambda for GET /notes
resource "aws_lambda_permission" "api_gateway_permission_notes_get" {
  statement_id  = "AllowAPIGatewayInvokeNotesGet"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.emr_backend.function_name
  principal     = "apigateway.amazonaws.com"
  # Needs the specific ARN format for the method/resource
  source_arn    = "${aws_api_gateway_rest_api.emr_api.execution_arn}/*/${aws_api_gateway_method.notes_get_method.http_method}${aws_api_gateway_resource.notes_resource.path}"
}

# --- OPTIONS Method for /notes (CORS Preflight) ---
resource "aws_api_gateway_method" "notes_options_method" {
  rest_api_id   = aws_api_gateway_rest_api.emr_api.id
  resource_id   = aws_api_gateway_resource.notes_resource.id
  http_method   = "OPTIONS"
  authorization = "NONE" # OPTIONS requests are not authenticated
}

# --- Integration for OPTIONS /notes (MOCK) ---
resource "aws_api_gateway_integration" "notes_options_integration" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.notes_resource.id
  http_method = aws_api_gateway_method.notes_options_method.http_method
  type        = "MOCK"
  request_templates = {
    "application/json" = "{\"statusCode\": 200}"
  }
}

# --- Method Response for OPTIONS /notes (200 OK) ---
resource "aws_api_gateway_method_response" "notes_options_200" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.notes_resource.id
  http_method = aws_api_gateway_method.notes_options_method.http_method
  status_code = "200"
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = true,
    "method.response.header.Access-Control-Allow-Methods" = true,
    "method.response.header.Access-Control-Allow-Origin"  = true
  }
  response_models = {
    "application/json" = "Empty" # No body for OPTIONS response
  }
}

# --- Integration Response for OPTIONS /notes ---
resource "aws_api_gateway_integration_response" "notes_options_integration_response" {
  rest_api_id = aws_api_gateway_rest_api.emr_api.id
  resource_id = aws_api_gateway_resource.notes_resource.id
  http_method = aws_api_gateway_method.notes_options_method.http_method
  status_code = aws_api_gateway_method_response.notes_options_200.status_code
  # Define CORS headers
  response_parameters = {
    "method.response.header.Access-Control-Allow-Headers" = "'Content-Type,X-Amz-Date,Authorization,X-Api-Key,X-Amz-Security-Token'",
    "method.response.header.Access-Control-Allow-Methods" = "'OPTIONS,GET'", # Allow GET requests
    "method.response.header.Access-Control-Allow-Origin"  = "'*'" # Be more specific in production if needed
  }
  response_templates = {
    "application/json" = "" # Empty body for OPTIONS response
  }
  depends_on = [aws_api_gateway_integration.notes_options_integration]
}