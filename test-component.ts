import { Configuration, ComponentsApi } from "@systeminit/api-client";

// Test script to verify component API calls work using SDK
const WORKSPACE_API_TOKEN = Deno.env.get('WORKSPACE_API_TOKEN');
const SI_WORKSPACE_ID = Deno.env.get('SI_WORKSPACE_ID');
const COMPONENT_ID = '01K9DFX28X8WGZ08MAG3GY8MJQ'; // Use your actual component ID
const CHANGESET_ID = 'head'; // or your actual changeset ID

if (!WORKSPACE_API_TOKEN || !SI_WORKSPACE_ID) {
  console.error('❌ Missing required environment variables');
  console.error('Please set WORKSPACE_API_TOKEN and SI_WORKSPACE_ID');
  Deno.exit(1);
}

console.log('🔧 Configuration:');
console.log(`   Workspace ID: ${SI_WORKSPACE_ID}`);
console.log(`   Component ID: ${COMPONENT_ID}`);
console.log(`   API Token Length: ${WORKSPACE_API_TOKEN.length} characters`);

console.log('\n🚀 Fetching component using SDK...');

try {
  const config = new Configuration({
    basePath: 'https://api.systeminit.com',
    accessToken: WORKSPACE_API_TOKEN,
    baseOptions: {
      headers: {
        'Authorization': `Bearer ${WORKSPACE_API_TOKEN}`,
        'Content-Type': 'application/json'
      }
    }
  });

  const componentsApi = new ComponentsApi(config);
  
  const response = await componentsApi.getComponent({
    workspaceId: SI_WORKSPACE_ID,
    changeSetId: CHANGESET_ID,
    componentId: COMPONENT_ID
  });

  console.log('\n✅ SDK Response received!');
  console.log('📊 Full Response:');
  console.log(JSON.stringify(response.data, null, 2));

  const component = response.data.component;
  if (component) {
    console.log(`\n🔍 Component Details:`);
    console.log(`   Name: ${component.name}`);
    console.log(`   Resource ID: ${component.resourceId}`);

    // Check for token in resource payload
    const resourcePayload = (component as any).attributes?.['/resource/payload'];
    if (resourcePayload?.initialApiToken?.token) {
      console.log('\n🎯 Found initialApiToken in resource payload!');
      console.log(`   Token: ${resourcePayload.initialApiToken.token.substring(0, 50)}...`);
      console.log(`   Expires: ${resourcePayload.initialApiToken.expiresAt}`);
      console.log(`   Workspace ID: ${resourcePayload.id}`);
    }

    // Check resourceProps
    console.log(`\n📝 Resource Props:`);
    (component as any).resourceProps?.forEach((prop: any, index: number) => {
      console.log(`   ${index + 1}. ${prop.path} = ${typeof prop.value === 'object' ? JSON.stringify(prop.value) : prop.value}`);
    });
  }

  console.log('\n✅ Script completed successfully!');
} catch (error: any) {
  console.error('\n❌ Error:', error.message);
  console.error('❌ Error details:', error);
  Deno.exit(1);
}