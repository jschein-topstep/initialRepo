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

  for (let i = 0; i < projectRecords.length; i++) {
    //if (projectRecords[i].proj_subsidiary__c != '22') {

    const sppTaskRequest = {
      authObj: authObj,
      recordType: "Projecttask",
      criteriaObj: {
        projectid: projectRecords[i].id,
      },
      limit: 2,
    };

    const taskRecords = await callSharedUtil(
      "tslib-getRecords",
      sppTaskRequest,
    );

    for (let j = 0; j < taskRecords.length; j++) {
      if (
        taskRecords[j].number_units__c !== 0 &&
        taskRecords[j].unit_price_per__c !== 0
      ) {
        const total =
          parseFloat(taskRecords[j].units_to_bill__c) *
          parseFloat(taskRecords[j].unit_price_per__c);

        const sppSlipWrite = {
          authObj: authObj,
          recordType: "Slip",
          writeObj: {
            projectid: projectRecords[i].id,
            category_1id: projectRecords[i].proj_subsidiary__c,
            //Add category id
            currency: projectRecords[i].currency,
            customerid: projectRecords[i].customerid,
            date: "2026-05-20",
            decimal_hours: taskRecords[j].units_to_bill__c,
            type: "T",
            projecttaskid: taskRecords[j].id,
            quantity: taskRecords[j].units_to_bill__c,
            rate: taskRecords[j].unit_price_per__c,
            total: total,
            userid: 251,
          },
        };

        const slipRecords = await callSharedUtil(
          "tslib-putRecords",
          sppSlipWrite,
        );
      }
    }
    //}
  }

  const response = {
    statusCode: 200,
    body: JSON.stringify(projectRecords),
  };
  return response;
};

async function test() {
  const result = await handler();
  console.log(JSON.stringify(result, null, 2));
}

if (!process.env.AWS_LAMBDA_FUNCTION_NAME) {
  test();
}
