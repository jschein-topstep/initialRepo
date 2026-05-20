/// <reference path="./.sst/platform/config.d.ts" />

export default $config({
  app() {
    return {
      name: "agency-lambdas",
      removal: "remove",
      home: "aws",
      providers: { aws: { region: "us-east-2" } }
    };
  },
  async run() {
    // ----------------------------------------------------
    // INVENTORY OF CLIENT FUNCTIONS
    // To add a new function, just copy-paste this block!
    // ----------------------------------------------------
    
    const clientAImport = new sst.aws.Function("ClientABidGrid", {
      handler: "packages/functions/client-a-import/index.handler",
      url: true, // Creates a live web URL for easy testing/triggering
      timeout: "60 seconds"
    });

    return {
      clientAUrl: clientAImport.url
    };
  },
});
