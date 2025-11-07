import { SubscriptionInput, TemplateContext } from "../src/template.ts";
import { z } from "npm:zod";

/**
 * AWS Standard VPC Template
 *
 * Creates a production-ready VPC with:
 * - 2 Public Subnets (across 2 AZs) with Internet Gateway access
 * - 2 Private Subnets (across 2 AZs) with NAT Gateway access
 * - Complete routing configuration
 * - DNS support enabled
 */
export default function (c: TemplateContext) {
  c.name("AWS Standard VPC");
  c.changeSet(`${c.name()} - ${c.invocationKey()}`);

  const inputSchema = z.object({
    environment: z.string().describe("Environment name (e.g., production, staging, dev)"),
    vpcCidr: z.string().default("10.0.0.0/16").describe("CIDR block for the VPC"),
    publicSubnet1Cidr: z.string().default("10.0.1.0/24").describe("CIDR block for public subnet 1"),
    publicSubnet2Cidr: z.string().default("10.0.2.0/24").describe("CIDR block for public subnet 2"),
    privateSubnet1Cidr: z.string().default("10.0.11.0/24").describe("CIDR block for private subnet 1"),
    privateSubnet2Cidr: z.string().default("10.0.12.0/24").describe("CIDR block for private subnet 2"),
    availabilityZone1: z.string().default("us-east-1a").describe("First availability zone"),
    availabilityZone2: z.string().default("us-east-1b").describe("Second availability zone"),
    credential: SubscriptionInput,
    region: SubscriptionInput,
  });

  c.inputs(inputSchema);
  c.search([
    "schema:AWS::EC2::VPC",
    "schema:AWS::EC2::Subnet",
    "schema:AWS::EC2::InternetGateway",
    "schema:AWS::EC2::NatGateway",
    "schema:AWS::EC2::RouteTable",
    "schema:AWS::EC2::Route",
    "schema:AWS::EC2::SubnetRouteTableAssociation",
    "schema:AWS::EC2::EIP",
    "schema:AWS::EC2::VPCGatewayAttachment",
  ]);

  type Inputs = z.infer<typeof inputSchema>;

  c.transform(async (workingSet, inputs) => {
    const typedInputs = inputs as Inputs;
    const env = typedInputs.environment;

    // ========================================
    // 1. CREATE VPC
    // ========================================
    const vpc = await c.newComponent("AWS::EC2::VPC", `${env}-vpc`, {
      "/domain/CidrBlock": typedInputs.vpcCidr,
      "/domain/EnableDnsHostnames": true,
      "/domain/EnableDnsSupport": true,
    });
    workingSet.push(vpc);

    // ========================================
    // 2. CREATE INTERNET GATEWAY
    // ========================================
    const igw = await c.newComponent(
      "AWS::EC2::InternetGateway",
      `${env}-igw`,
    );
    workingSet.push(igw);

    // ========================================
    // 3. ATTACH INTERNET GATEWAY TO VPC
    // ========================================
    const igwAttachment = await c.newComponent(
      "AWS::EC2::VPCGatewayAttachment",
      `${env}-igw-attachment`,
    );
    c.setSubscription(igwAttachment, "/domain/VpcId", {
      kind: "$source",
      component: vpc.id,
      path: "/resource_value/VpcId",
    });
    c.setSubscription(igwAttachment, "/domain/InternetGatewayId", {
      kind: "$source",
      component: igw.id,
      path: "/resource_value/InternetGatewayId",
    });
    workingSet.push(igwAttachment);

    // ========================================
    // 4. CREATE PUBLIC SUBNETS (2 AZs)
    // ========================================
    const publicSubnet1 = await c.newComponent(
      "AWS::EC2::Subnet",
      `${env}-public-subnet-1`,
      {
        "/domain/CidrBlock": typedInputs.publicSubnet1Cidr,
        "/domain/AvailabilityZone": typedInputs.availabilityZone1,
        "/domain/MapPublicIpOnLaunch": true,
      },
    );
    c.setSubscription(publicSubnet1, "/domain/VpcId", {
      kind: "$source",
      component: vpc.id,
      path: "/resource_value/VpcId",
    });
    workingSet.push(publicSubnet1);

    const publicSubnet2 = await c.newComponent(
      "AWS::EC2::Subnet",
      `${env}-public-subnet-2`,
      {
        "/domain/CidrBlock": typedInputs.publicSubnet2Cidr,
        "/domain/AvailabilityZone": typedInputs.availabilityZone2,
        "/domain/MapPublicIpOnLaunch": true,
      },
    );
    c.setSubscription(publicSubnet2, "/domain/VpcId", {
      kind: "$source",
      component: vpc.id,
      path: "/resource_value/VpcId",
    });
    workingSet.push(publicSubnet2);

    // ========================================
    // 5. CREATE PRIVATE SUBNETS (2 AZs)
    // ========================================
    const privateSubnet1 = await c.newComponent(
      "AWS::EC2::Subnet",
      `${env}-private-subnet-1`,
      {
        "/domain/CidrBlock": typedInputs.privateSubnet1Cidr,
        "/domain/AvailabilityZone": typedInputs.availabilityZone1,
        "/domain/MapPublicIpOnLaunch": false,
      },
    );
    c.setSubscription(privateSubnet1, "/domain/VpcId", {
      kind: "$source",
      component: vpc.id,
      path: "/resource_value/VpcId",
    });
    workingSet.push(privateSubnet1);

    const privateSubnet2 = await c.newComponent(
      "AWS::EC2::Subnet",
      `${env}-private-subnet-2`,
      {
        "/domain/CidrBlock": typedInputs.privateSubnet2Cidr,
        "/domain/AvailabilityZone": typedInputs.availabilityZone2,
        "/domain/MapPublicIpOnLaunch": false,
      },
    );
    c.setSubscription(privateSubnet2, "/domain/VpcId", {
      kind: "$source",
      component: vpc.id,
      path: "/resource_value/VpcId",
    });
    workingSet.push(privateSubnet2);

    // ========================================
    // 6. CREATE ELASTIC IP FOR NAT GATEWAY
    // ========================================
    const natEip = await c.newComponent(
      "AWS::EC2::EIP",
      `${env}-nat-eip`,
      {
        "/domain/Domain": "vpc",
      },
    );
    workingSet.push(natEip);

    // ========================================
    // 7. CREATE NAT GATEWAY (in public subnet)
    // ========================================
    const natGateway = await c.newComponent(
      "AWS::EC2::NatGateway",
      `${env}-nat-gateway`,
    );
    c.setSubscription(natGateway, "/domain/SubnetId", {
      kind: "$source",
      component: publicSubnet1.id,
      path: "/resource_value/SubnetId",
    });
    c.setSubscription(natGateway, "/domain/AllocationId", {
      kind: "$source",
      component: natEip.id,
      path: "/resource_value/AllocationId",
    });
    workingSet.push(natGateway);

    // ========================================
    // 8. CREATE PUBLIC ROUTE TABLE
    // ========================================
    const publicRouteTable = await c.newComponent(
      "AWS::EC2::RouteTable",
      `${env}-public-rt`,
    );
    c.setSubscription(publicRouteTable, "/domain/VpcId", {
      kind: "$source",
      component: vpc.id,
      path: "/resource_value/VpcId",
    });
    workingSet.push(publicRouteTable);

    // ========================================
    // 9. CREATE PUBLIC ROUTE TO INTERNET GATEWAY
    // ========================================
    const publicRoute = await c.newComponent(
      "AWS::EC2::Route",
      `${env}-public-route`,
      {
        "/domain/DestinationCidrBlock": "0.0.0.0/0",
      },
    );
    c.setSubscription(publicRoute, "/domain/RouteTableId", {
      kind: "$source",
      component: publicRouteTable.id,
      path: "/resource_value/RouteTableId",
    });
    c.setSubscription(publicRoute, "/domain/GatewayId", {
      kind: "$source",
      component: igw.id,
      path: "/resource_value/InternetGatewayId",
    });
    workingSet.push(publicRoute);

    // ========================================
    // 10. ASSOCIATE PUBLIC SUBNETS WITH PUBLIC ROUTE TABLE
    // ========================================
    const publicSubnet1RtAssoc = await c.newComponent(
      "AWS::EC2::SubnetRouteTableAssociation",
      `${env}-public-subnet-1-rt-assoc`,
    );
    c.setSubscription(publicSubnet1RtAssoc, "/domain/SubnetId", {
      kind: "$source",
      component: publicSubnet1.id,
      path: "/resource_value/SubnetId",
    });
    c.setSubscription(publicSubnet1RtAssoc, "/domain/RouteTableId", {
      kind: "$source",
      component: publicRouteTable.id,
      path: "/resource_value/RouteTableId",
    });
    workingSet.push(publicSubnet1RtAssoc);

    const publicSubnet2RtAssoc = await c.newComponent(
      "AWS::EC2::SubnetRouteTableAssociation",
      `${env}-public-subnet-2-rt-assoc`,
    );
    c.setSubscription(publicSubnet2RtAssoc, "/domain/SubnetId", {
      kind: "$source",
      component: publicSubnet2.id,
      path: "/resource_value/SubnetId",
    });
    c.setSubscription(publicSubnet2RtAssoc, "/domain/RouteTableId", {
      kind: "$source",
      component: publicRouteTable.id,
      path: "/resource_value/RouteTableId",
    });
    workingSet.push(publicSubnet2RtAssoc);

    // ========================================
    // 11. CREATE PRIVATE ROUTE TABLE
    // ========================================
    const privateRouteTable = await c.newComponent(
      "AWS::EC2::RouteTable",
      `${env}-private-rt`,
    );
    c.setSubscription(privateRouteTable, "/domain/VpcId", {
      kind: "$source",
      component: vpc.id,
      path: "/resource_value/VpcId",
    });
    workingSet.push(privateRouteTable);

    // ========================================
    // 12. CREATE PRIVATE ROUTE TO NAT GATEWAY
    // ========================================
    const privateRoute = await c.newComponent(
      "AWS::EC2::Route",
      `${env}-private-route`,
      {
        "/domain/DestinationCidrBlock": "0.0.0.0/0",
      },
    );
    c.setSubscription(privateRoute, "/domain/RouteTableId", {
      kind: "$source",
      component: privateRouteTable.id,
      path: "/resource_value/RouteTableId",
    });
    c.setSubscription(privateRoute, "/domain/NatGatewayId", {
      kind: "$source",
      component: natGateway.id,
      path: "/resource_value/NatGatewayId",
    });
    workingSet.push(privateRoute);

    // ========================================
    // 13. ASSOCIATE PRIVATE SUBNETS WITH PRIVATE ROUTE TABLE
    // ========================================
    const privateSubnet1RtAssoc = await c.newComponent(
      "AWS::EC2::SubnetRouteTableAssociation",
      `${env}-private-subnet-1-rt-assoc`,
    );
    c.setSubscription(privateSubnet1RtAssoc, "/domain/SubnetId", {
      kind: "$source",
      component: privateSubnet1.id,
      path: "/resource_value/SubnetId",
    });
    c.setSubscription(privateSubnet1RtAssoc, "/domain/RouteTableId", {
      kind: "$source",
      component: privateRouteTable.id,
      path: "/resource_value/RouteTableId",
    });
    workingSet.push(privateSubnet1RtAssoc);

    const privateSubnet2RtAssoc = await c.newComponent(
      "AWS::EC2::SubnetRouteTableAssociation",
      `${env}-private-subnet-2-rt-assoc`,
    );
    c.setSubscription(privateSubnet2RtAssoc, "/domain/SubnetId", {
      kind: "$source",
      component: privateSubnet2.id,
      path: "/resource_value/SubnetId",
    });
    c.setSubscription(privateSubnet2RtAssoc, "/domain/RouteTableId", {
      kind: "$source",
      component: privateRouteTable.id,
      path: "/resource_value/RouteTableId",
    });
    workingSet.push(privateSubnet2RtAssoc);

    // ========================================
    // 14. SET CREDENTIALS, REGION, AND TAGS FOR ALL COMPONENTS
    // ========================================
    for (const component of workingSet) {
      // Set AWS Credential
      await c.setSubscription(
        component,
        "/secrets/AWS Credential",
        typedInputs.credential,
      );
      // Set AWS Region
      await c.setSubscription(
        component,
        "/domain/extra/Region",
        typedInputs.region,
      );
      // Set Name tag for all components
      c.setSiblingAttribute(
        component,
        /\/domain\/Tags\/\d+\/Key/,
        "Name",
        "Value",
        component.name,
      );
    }

    return workingSet;
  });
}
