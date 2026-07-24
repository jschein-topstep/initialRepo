const sharedPath = process.env.AWS_LAMBDA_FUNCTION_NAME
? "/opt/nodejs/sharedUtils.js"
: "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);

    const authObj = {
        company: process.env.COMPANY,
        user: process.env.USER,
        password: process.env.PASSWORD,
        instance: process.env.INSTANCE,
    };

    export const handler = async (event) => {

    const postUrl="https://"+NS_acct_num+".suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token";

    const sppProjectRequest = {
        authObj: authObj,
        recordType: "Project",
        criteriaObj: {
            active: 1,
        },
        limit: 2,
        fields: "id,proj_subsidiary__c,currency,customerid",
    };

    const projectRecords = await callSharedUtil(
        "tslib-getRecords",
        sppProjectRequest,
    );
    console.log("Project records: ", JSON.stringify(projectRecords));
    console.log("Project records length: ", projectRecords.length);

    const response = {
        statusCode: 200,
        body: JSON.stringify(projectRecords),
    };
    return response;
    };