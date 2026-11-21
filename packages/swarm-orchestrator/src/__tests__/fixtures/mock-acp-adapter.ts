let selectedModel = 'openrouter:default-model';
let mcpServerNames: string[] = [];

for await (const line of console) {
  const message = JSON.parse(line);
  const reply = (result: unknown) => {
    console.log(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
  };

  switch (message.method) {
    case 'initialize':
      reply({ protocolVersion: 1, agentCapabilities: {} });
      break;
    case 'session/new':
      mcpServerNames = (message.params.mcpServers ?? []).map((server: { name: string }) => server.name);
      reply({
        sessionId: 'mock-session',
        configOptions: [{
          id: 'model',
          name: 'Model',
          category: 'model',
          type: 'select',
          currentValue: selectedModel,
          options: [{ value: selectedModel, name: selectedModel }, {value:'alternate-model',name:'Alternate'}],
        }],
      });
      break;
    case 'session/set_config_option':
      if (process.env.MOCK_IGNORE_MODEL !== '1') selectedModel = message.params.value;
      reply({ configOptions: [{id:'model',name:'Model',category:'model',type:'select',currentValue:selectedModel,options:[{value:selectedModel,name:selectedModel}]}] });
      break;
    case 'session/prompt':
      const promptText = message.params.prompt?.[0]?.text;
      if (promptText === 'buffered activity') {
        for (let n = 0; n < 8; n++) {
          console.log(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:'mock-session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:' '}}}}));
          await Bun.sleep(50);
        }
      }

      console.log(JSON.stringify({
        jsonrpc: '2.0',
        method: 'session/update',
        params: {
          sessionId: 'mock-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: {
              type: 'text',
              text: promptText === 'report model'
                ? selectedModel
                : promptText === 'report mcp'
                  ? mcpServerNames.join(',')
                  : 'STREAMED_OK',
            },
          },
        },
      }));
      reply({ stopReason: 'end_turn' });
      break;
    case 'session/cancel':
      break;
    default:
      console.log(JSON.stringify({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      }));
  }
}
