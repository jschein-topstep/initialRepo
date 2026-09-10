
import { LambdaClient, InvokeCommand } from "@aws-sdk/client-lambda";

const lambdaClient = new LambdaClient({ region: "us-east-2" });
const sharedPath = process.env.AWS_LAMBDA_async function_NAME
    ? "/opt/nodejs/sharedUtils.js"
    : "../../shared/sharedUtils.js";
const { callSharedUtil } = await import(sharedPath);

const authObj = {
    company: process.env.COMPANY,
    user: process.env.USER,
    password: process.env.PASSWORD,
    instance: process.env.INSTANCE,
};

/* const phaseWriteRequest = {
    authObj: authObj,
    recordType: "Projecttask",
    writeObj: phaseObjArray,
};

const phaseWriteResponse = await callSharedUtil(
    "tslib-putRecords",
    phaseWriteRequest,
); 
  }*/

export const handler = async (event) => {
    const bodyJSON = JSON.parse(event.body);

  //  var qbLib = require("QB_Lib");
    var qb_base_url = process.env.QB_Base_URL;
    var qb_company_id = process.env.QB_Company_ID;
    var emailLogAddress = process.env.email_for_errors;

  //  var lastRun = lib.getLastRunDate("QB_Integration");
   // var lastRunMilli = lib.getLastRunDateMilliseconds("QB_Integration");
    //lastRun.day = "16";
    //lastRun.hour = 
  //  lastRun.second = 1;
 //   console.log("Last run " + JSON.stringify(lastRun));
 //   var lastRunString = lib.getOADateTimeString(lastRun, "yyyy-MM-ddThh:mm:ssZ");
    var today = new Date();
   // console.log("before the set last run " + JSON.stringify(lastRun) + " Last Run String " + lastRunString);
  //  lib.setLastRunDate("QB_Integration", today.getTime());

    //create the log file. 

    // lastRunString = "2022-10-19T14:02:47Z";

   // var logFile = new lib.ExceptionLog();
   // var errorLogFile = new lib.ExceptionLog();

    try {


         console.log("before sync customer ");
             testRead(qb_base_url,qb_company_id);


      //  syncCustomers(qb_base_url, qb_company_id, lastRun, logFile, errorLogFile);
       // NSOA.meta.log('Info', "Customers Synced ");
      //  syncProjects(qb_base_url, qb_company_id, lastRun, logFile, errorLogFile);
      //  NSOA.meta.log('Info', "Projects Synced");
      //  syncInvoices(qb_base_url, qb_company_id, lastRun, logFile, errorLogFile);
      //  NSOA.meta.log('Info', "Invoices Synced");


        // getPayments(qb_base_url, qb_company_id, lastRunString, logFile, errorLogFile);
        // getCreditMemos(qb_base_url, qb_company_id, lastRunString, logFile, errorLogFile);


    } catch (e) {
      //  NSOA.meta.log('error', "Error caught " + JSON.stringify(e));
       // errorLogFile.add("Error in the main " + JSON.stringify(e));
      //  lib.setLastRunDate("QB_Integration", lastRunMilli);
    }

  //  logFile.emailList(emailLogAddress);
  //  errorLogFile.emailList(emailLogAddress);


}


async function testRead(qb_base_url, qb_company_id) {
 //   var lib = require("tsLib_4");

   // var qbLib = require("QB_Lib");

    //select id,CompanyName from Customer Where Metadata.LastUpdatedTime > '2015-03-01'

    var url = qb_base_url + "v3/company/" + qb_company_id + "/companyinfo/" + qb_company_id;  //minorversion=65";

    //  var url = qb_base_url + "v3/company/" + qb_company_id + "/query?query=select id,CompanyName from Customer Where Metadata.LastUpdatedTime > '2015-03-01'&minorverizon=65";

    //  var url = qb_base_url + "v3/company/" + qb_company_id + "/query?query=select id,CompanyName from Customer Where Metadata.LastUpdatedTime > '2015-03-01'&minorverizon=65";

    console.log(url);

   // var header = qbLib.get_auth_header();

    // console.log("Auth header " + JSON.stringify(header));

  //  var response = NSOA.https.get({
  //     url: url,
  //      headers: header
 //   });

    // logFile.add("Customer created - id: " + response.body.Customer.id + ", name: " + response.body.Customer.name);
  //  console.log("Company Response " + JSON.stringify(response));
}


async function syncCustomers(qb_base_url, qb_company_id, newerThanDate, log, errorLog) {

    //console.log("Entering SyncCustomers");

    var qbLib = require("QB_Lib");
    var tsLib = require("tsLib_4");
    var cust = new NSOA.record.oaCustomer();

    var custRead = {
        type: "Customer",
        method: "all",
        fields: "",
        attributes: [{
            name: "limit",
            value: "1000"
        },
        {
            name: "filter",
            value: "newer-than"
        },
        {
            name: "field",
            value: "updated"
        }],
        objects: [cust, newerThanDate]
    };

    var custResults = NSOA.wsapi.read(custRead);
    if (custResults[0].objects !== null) {
        console.log("Number of Customers Returned " + custResults[0].objects.length);
        for (var i = 0; i < custResults[0].objects.length; i++) {
            if (custResults[0].objects[i].qb_client_id__c !== "") {

                updateCustomer(qb_base_url, qb_company_id, custResults[0].objects[i], log, errorLog);

                // console.log("after the update cusotmer ");
                var proj = new NSOA.record.oaProject();
                proj.customerid = custResults[0].objects[i].id;

                var projects = tsLib.getRecords(proj, "Project", 10);

                // console.log("after the ts lib get ");

                if (projects !== null) {

                    for (var j = 0; j < projects.length; j++) {
                        console.log("Update Projects in customer " + projects[j].name + " " + projects[j].id);
                        if (projects[j].qb_project_id__c !== "") {
                            updateProject(qb_base_url, qb_company_id, projects[j], log, errorLog);
                        }
                    }
                }

            } else {
                createCustomer(qb_base_url, qb_company_id, custResults[0].objects[i], log, errorLog);
            }
        }

    }
}

async function syncProjects(qb_base_url, qb_company_id, newerThanDate, log, errorLog) {
    var qbLib = require("QB_Lib");
    var proj = new NSOA.record.oaProject();

    var projRead = {
        type: "Project",
        method: "equal to",
        fields: "",
        attributes: [{
            name: "limit",
            value: "1000"
        },
        {
            name: "filter",
            value: "newer-than"
        },
        {
            name: "field",
            value: "updated"
        }],
        objects: [proj, newerThanDate]
    };

    var projResults = NSOA.wsapi.read(projRead);
    if (projResults[0].objects !== null) {
        for (var i = 0; i < projResults[0].objects.length; i++) {
            if (projResults[0].objects[i].qb_project_id__c !== "") {
                console.log("Project to Update " + projResults[0].objects[i].qb_project_id__c);
                updateProject(qb_base_url, qb_company_id, projResults[0].objects[i], log, errorLog);
            } else {
                createProject(qb_base_url, qb_company_id, projResults[0].objects[i], log, errorLog);
            }


        }
    }

}



async function syncInvoices(qb_base_url, qb_company_id, newerThanDate, log, errorLogFile) {

    console.log("Sync Invoices");
    var qbLib = require("QB_Lib");

    var attributes = [
        {
            name: "update_custom",
            value: "1"
        }
    ];

    var inv = new NSOA.record.oaInvoice();
    inv.approval_status = "A";

    var invRead = {
        type: "Invoice",
        method: "equal to",
        fields: "",
        attributes: [{
            name: "limit",
            value: "1000"
        },
        {
            name: "filter",
            value: "newer-than"
        },
        {
            name: "field",
            value: "updated"
        }],
        objects: [inv, newerThanDate]
    };

    var invResults = NSOA.wsapi.read(invRead);
    //  console.log("Ivoices read ");
    if (invResults[0].objects !== null) {
        for (var i = 0; i < invResults[0].objects.length; i++) {
            //console.log("Entering the invoices");
            if (invResults[0].objects[i].qb_invoice_id__c === "") {
                //console.log("2");
                var invReturn = createInvoice(qb_base_url, qb_company_id, invResults[0].objects[i], log, errorLogFile);
                console.log("Invoice ID Returned " + invReturn);
                if (invReturn == "-1") {
                    NSOA.meta.log("debug", "Error Creating Invoice in QB" + invResults[0].objects[i].name);
                } else {
                    var upIn = new NSOA.record.oaInvoice();
                    upIn.id = invResults[0].objects[i].id;
                    upIn.qb_invoice_id__c = invReturn;


                    var modResults = NSOA.wsapi.modify(attributes, [upIn]);
                    console.log("Invoice to Update " + JSON.stringify(upIn) + " mod results " + JSON.stringify(modResults));
                    if (modResults[0].status !== 'U') {
                        console.log("Error Updating Invoice " + upIn.id);
                    } else {
                        console.log("Invoice Updated " + upIn.id);
                    }
                }
            }

        }

    } else {
        console.log("Invoices null");
    }
}

async function createCustomer(qb_base_url, qb_company_id, oaCustomer, logFile, errorLogFile) {
    console.log("Entering Create Customer ");
    var lib = require("tsLib_3");
    var QB_Lib = require("QB_Lib");
    var returnMe = "-1";
    var qbActive = true;

    if (oaCustomer.active !== "1") {
        qbActive = false;
    }

    var user;
    if (oaCustomer.Initial_Client_Manager__c !== "") {
        user = NSOA.record.oaUser(oaCustomer.Initial_Client_Manager__c);
    }
    var qbCustomer = {
        "PrimaryEmailAddr": {
            "Address": oaCustomer.addr_email
        },

        "GivenName": oaCustomer.addr_first,
        "DisplayName": oaCustomer.name,
        "FullyQualifiedName": oaCustomer.company,
        "BillWithParent": false,
        "CompanyName": oaCustomer.company,
        "FamilyName": oaCustomer.addr_last,
        "PrimaryPhone": {
            "FreeFormNumber": oaCustomer.addr_phone,
        },
        "Active": qbActive,
        "Job": false,
        "Notes": user.name,
        "BillAddr": {
            "City": oaCustomer.addr_city,
            "Line1": oaCustomer.addr_addr1,
            "Line2": oaCustomer.addr_addr2,
            "Line3": oaCustomer.addr_addr3,
            "Line4": oaCustomer.addr_addr4,
            "PostalCode": oaCustomer.addr_zip,
            "CountrySubDivisionCode": oaCustomer.addr_state,
        },
    };

    // console.log(JSON.stringify(qbCustomer));


    console.log("Customer to be created: " + JSON.stringify(qbCustomer));
    var url = qb_base_url + "v3/company/" + qb_company_id + "/customer?minorversion=65";
    // var url = "https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365218828440/customer?minorversion=65";
    var header = QB_Lib.get_auth_header();

    // console.log("Auth header " + JSON.stringify(header));

    var response = NSOA.https.post({
        url: url,
        headers: header,
        body: qbCustomer
    });

    // logFile.add("Customer created - id: " + response.body.Customer.id + ", name: " + response.body.Customer.name);
    console.log("Create Company Response " + JSON.stringify(response));

    if (response.code !== 200) {
        errorLogFile.add("Error creating customer in Quickbooks: " + oaCustomer.name);
        NSOA.meta.log("error", "Error creating company " + oaCustomer.name);
    } else {
        returnMe = response.body.Customer.Id;
        logFile.add("Added Customer " + response.body.Customer.name);
        setExternalId(oaCustomer.id, response.body.Customer.Id, errorLogFile);
    }

    return returnMe;
}

async function setExternalId(oaCustomerID, qbCustomerID, errorLog) {

    var updatedOACustomer = new NSOA.record.oaCustomer();
    updatedOACustomer.id = oaCustomerID;
    updatedOACustomer.qb_client_id__c = qbCustomerID;

    // Not attributes required
    var attributes = [
        {
            name: "update_custom",
            value: "1"
        }
    ];

    // Invoke the modify call
    var results = NSOA.wsapi.modify(attributes, [updatedOACustomer]);
    if (results[0].status !== "U") {
        NSOA.meta.log('error', "Error updating customer " + JSON.stringify(results[0]));
        errorLog.add("Error updating customer " + JSON.stringify(results[0]));
    } else {
        NSOA.meta.log('info', "Customer update successful " + results[0].id + "with QB Id: " + qbCustomerID);


    }

}


async function createProject(qb_base_url, qb_company_id, oaProject, logFile, errorLogFile) {
    //console.log("Entering Project Customer ");

    var lib = require("tsLib_4");
    var QB_Lib = require("QB_Lib");
    var returnMe = "-1";
    var qbActive = true;

    if (oaProject.active !== "1") {
        qbActive = false;
    }

    var user;

    var oaCustomer = new NSOA.record.oaCustomer(oaProject.customerid);

    var cust = new NSOA.record.oaCustomer(oaProject.customerid);
    if (cust.Initial_Client_Manager__c !== "") {
        user = NSOA.record.oaUser(cust.Initial_Client_Manager__c);
    }

    if (cust.qb_client_id__c !== "") {
        // console.log("Project - Customer info " + cust.qb_client_id__c + " " + cust.name);

        var qbProject = {
            "GivenName": oaProject.name,
            "DisplayName": oaProject.name,
            "FullyQualifiedName": oaProject.name,
            "BillWithParent": false,
            "CompanyName": oaProject.name,
            "FamilyName": "",
            "Active": qbActive,
            "Job": true,
            "Notes": user.name,
            "PrimaryPhone": {
                "FreeFormNumber": oaCustomer.addr_phone,
            },
            "ParentRef":
            {
                "value": cust.qb_client_id__c
            },
            "BillAddr": {
                "City": oaCustomer.addr_city,
                "Line1": oaCustomer.addr_addr1,
                "Line2": oaCustomer.addr_addr2,
                "Line3": oaCustomer.addr_addr3,
                "Line4": oaCustomer.addr_addr4,
                "PostalCode": oaCustomer.addr_zip,
                "CountrySubDivisionCode": oaCustomer.addr_state,
            },
        };

        console.log("Project to create" + JSON.stringify(qbProject));


        //  console.log("Project to be created: " + JSON.stringify(qbProject));
        var url = qb_base_url + "v3/company/" + qb_company_id + "/customer?minorversion=65";
        //var url = "https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365218828440/customer?minorversion=65";
        var header = QB_Lib.get_auth_header();

        // console.log("Auth header " + JSON.stringify(header));

        var response = NSOA.https.post({
            url: url,
            headers: header,
            body: qbProject
        });


        console.log("Create Project Response " + JSON.stringify(response));

        if (response.code !== 200) {
            errorLogFile.add("Error creating project with id: " + oaProject.id + ", name: " + oaProject.name);
            NSOA.meta.log("error", "Error creating Project " + oaProject.name);
        } else {
            returnMe = response.body.Customer.Id;
            console.log("Project Created ");
            logFile.add("Project created - id: " + response.body.Customer.Id + ", name: " + response.body.Customer.name);
            setExternalProjectId(oaProject.id, response.body.Customer.Id, errorLogFile);
        }

    }

    return returnMe;
}

async function setExternalProjectId(oaProjectID, qbCustomerID, errorLog) {
    // Modify customers externalId
    // console.log("Updating Project External ID " + oaProjectID + " " + qbCustomerID);

    var updatedOAProject = new NSOA.record.oaProject();
    updatedOAProject.id = oaProjectID;
    updatedOAProject.qb_project_id__c = qbCustomerID;

    // Not attributes required
    var attributes = [
        {
            name: "update_custom",
            value: "1"
        }
    ];

    // Invoke the modify call
    var results = NSOA.wsapi.modify(attributes, [updatedOAProject]);
    if (results[0].status !== "U") {
        NSOA.meta.log('error', "Error updating Project " + JSON.stringify(results[0]));
        errorLog.add("Error updating Project " + JSON.stringify(results[0]));
    } else {
        NSOA.meta.log('info', "Project update successful " + results[0].id);

    }

}



async function createInvoice(qb_base_url, qb_company_id, oaInvoice, logFile, errorLogFile) {

    var lib = require("tsLib_4");
    var QB_Lib = require("QB_Lib");

    var returnID = "-1";

    //   console.log("Customer id = " + oaInvoice.customerid);
    var customer = new NSOA.record.oaCustomer(oaInvoice.customerid);
    //  console.log("Here is the customer " + JSON.stringify(customer) + " " + customer.id);

    var qbCustomerID = customer.qb_client_id__c;

    if (customer.qb_client_id__c === "") {
        qbCustomerID = createCustomer(qb_base_url, qb_company_id, customer, logFile, errorLogFile);
    }

    var user;

    if (customer.Initial_Client_Manager__c !== "") {
        user = NSOA.record.oaUser(customer.Initial_Client_Manager__c);
    }

    var cmName = user.name;

    var docNumber = oaInvoice.number;

    var sumAllLines = NSOA.context.getParameter("sum_invoice_lines");
    var oneProject = NSOA.context.getParameter("QB_one_project_per_invoice");
    var invoiceNotes = oaInvoice.notes;
    var termAmt = "";
    var paymentId = oaInvoice.terms;
    if (paymentId.indexOf("receipt") == -1) {
        termAmt = paymentId.substr(paymentId.length - 2, paymentId.length - 1);
        termAmt = parseFloat(termAmt);
    }
    else {

        termAmt = 0;
    }


    var qbTermId = "";

    var oaTerm1 = new NSOA.record.oaPaymentterms();
    oaTerm1.name = oaInvoice.terms;
    console.log("Invoice terms " + oaInvoice.terms + " " + termAmt);
    var oaTerms = lib.getRecords(oaTerm1, "Paymentterms", 1);

    if (oaTerms !== null) {


        qbTermId = oaTerms[0].qb_terms_id__c;
        //   console.log("Received a term " + oaTerms[0].name + " " + oaTerms[0].qb_terms_id__c + " " + qbTermId);

    } else {
        console.log("No terms found ");
    }

    console.log("Terms = " + qbTermId + " " + oaTerm1.name);
    var invoiceDate = oaInvoice.date;
    invoiceDate = invoiceDate.substr(0, 10);
    var dueDate = invoiceDate;
    invoiceDate.replace(/-/g, "/");
    NSOA.meta.log("info", "InvoiceDate: " + invoiceDate);  //T05:00:00Z 
    dueDate = new Date(dueDate + "T05:00:00Z");
    dueDate.setDate(dueDate.getDate() + termAmt);
    NSOA.meta.log("info", "Due Date: " + dueDate);
    var dueDateUpd = lib.getDateString(dueDate, "yyyy-MM-dd");
    dueDateUpd.replace(/-/g, "/");
    if (termAmt == 0) {
        dueDateUpd = "";
    }

    var slip = new NSOA.record.oaSlip();
    slip.invoiceid = oaInvoice.id;
    var slips = lib.getRecords(slip, "Slip", 1000);

    //  console.log("Slips ");

    var poNumber = "";

    if (oneProject) {
        if (slips !== null) {
            var projectID = slips[0].projectid;
            var proj = new NSOA.record.oaProject(projectID);

            var qbProjectID = proj.qb_project_id__c;

            var customerPOID = slips[0].customerpoid;

            if (customerPOID !== "") {
                var custPO = new NSOA.record.oaCustomerpo(customerPOID);
                poNumber = custPO.number;
            }

            //  console.log("Customer PO Number " + poNumber);

            if (qbProjectID === "") {
                qbProjectID = createProject(qb_base_url, qb_company_id, proj, logFile, errorLogFile);
            }

            qbCustomerID = qbProjectID;

        }
    }

    var Lines = [];
    var line;

    var creditMemoFlag = false;
    if (parseFloat(oaInvoice.total) < 0) {
        creditMemoFlag = true;
    }


    if (slips !== null) {
        //  console.log("Slips not null ");

        if (sumAllLines == 1) {
            //  console.log("sum Lines");
            Lines = createSumInvoiceLines(slips);
            //   console.log("Lines " + JSON.stringify(Lines));
        }
        else {
            //   if (slips !== null) {
            //  console.log("Slip record " + JSON.stringify(slips));
            for (var j = 0; j < slips.length; j++) {


                var itemID;
                var itemName;

                var chargeService = slips[j].categoryid;
                var catRec = new NSOA.record.oaCategory(chargeService);
                itemName = catRec.name;
                itemID = catRec.qb_item_id__c;



                var squantity = 1;
                var sunitPrice = slips[j].total;
                if (slips[j].quantity === "0.000") {
                    squantity = "1";
                } else {
                    squantity = slips[j].quantity;
                    sunitPrice = slips[j].cost;
                }

                if (creditMemoFlag === false) {
                    {
                        line = {
                            "Description": slips[j].description,
                            "DetailType": "SalesItemLineDetail",
                            "SalesItemLineDetail": {
                                "TaxCodeRef": {
                                    "value": "NON"
                                },
                                "Qty": squantity,
                                "UnitPrice": sunitPrice,
                                "ItemRef": {
                                    "name": itemName,
                                    "value": itemID
                                }
                            },
                            "Amount": slips[j].total,

                        };

                        //   console.log(" Line " + j + " " + JSON.stringify(line));
                        Lines.push(line);
                    }
                }
                else {
                    {

                        line = {
                            "Description": slips[j].description,
                            "DetailType": "SalesItemLineDetail",
                            "SalesItemLineDetail": {
                                "TaxCodeRef": {
                                    "value": "NON" //TAX / NON
                                },
                                "Qty": squantity,
                                "UnitPrice": sunitPrice,
                                "ItemRef": {
                                    "name": itemName,
                                    "value": itemID
                                }
                            },
                            "Amount": slips[j].total,
                            //LineNum needed? or auto populated
                        };

                        //    console.log(" Line " + j + " " + JSON.stringify(line));
                        Lines.push(line);
                    }
                }

            }
        }

        //  console.log("12334");

    } else {
        console.log("Slips are null ");
    }

    invoiceNotes = "";

    // console.log("Enterning updating the Invoice " + qbTermId);
    if (creditMemoFlag === false) {
        var qbInvoice = {
            "CustomerRef": {

                "value": qbCustomerID
            },
            "DocNumber": docNumber,
            "TxnDate": invoiceDate,
            "DueDate": dueDateUpd,
            CustomerMemo: {
                value: invoiceNotes,
            },
            SalesTermRef: {
                value: qbTermId,
            },
            "CustomField": [{
                DefinitionId: "2",
                Name: "Sales Rep",
                Type: "StringType",
                StringValue: cmName
            },
            {
                DefinitionId: "1",
                Name: "P.O. Number",
                Type: "StringType",
                StringValue: poNumber
            }],
            "Line": Lines
        };
        console.log("Invoice to be created " + JSON.stringify(qbInvoice));
        var url = qb_base_url + "v3/company/" + qb_company_id + "/invoice?minorversion=65";
        //  var url = "https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365218828440/invoice?minorversion=65";
        var header = QB_Lib.get_auth_header();
        //  console.log("Auth header " + JSON.stringify(header));
        var response = NSOA.https.post({
            url: url,
            headers: header,
            body: qbInvoice
        });
        console.log("Create Invoice Response " + JSON.stringify(response));
        if (response.code !== 200) {
            errorLogFile.add("Error creating invoice with id: " + oaInvoice.id + ", Customer name: " + customer.name);
            NSOA.meta.log("error", "Error creating invoice " + oaInvoice.id);
        } else {
            logFile.add("Invoice created - id: " + response.body.Invoice.Id);
            var returnedInvoice = {
                "id": response.body.Invoice.Id
            };
            returnID = response.body.Invoice.Id;

            exportSlips(slips);
        }
    }
    else {
        var qbInvoice2 = {
            "CustomerRef": {

                "value": qbCustomerID
            },
            "DocNumber": docNumber,
            "TxnDate": invoiceDate,
            "DueDate": dueDateUpd,
            CustomerMemo: {
                value: invoiceNotes,
            },
            SalesTermRef: {
                value: qbTermId,
            },
            "Line": Lines
        };
        console.log("CreditMemo created " + JSON.stringify(qbInvoice2));
        var url2 = qb_base_url + "v3/company/" + qb_company_id + "/CreditMemo?minorversion=65";
        //  var url = "https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365218828440/invoice?minorversion=65";
        var header2 = QB_Lib.get_auth_header();
        console.log("Auth header " + JSON.stringify(header2));
        var response2 = NSOA.https.post({
            url: url2,
            headers: header2,
            body: qbInvoice2
        });
        console.log("Create CreditMemo Response " + JSON.stringify(response2));
        if (response2.code !== 200) {
            errorLogFile.add("Error creating CreditMemo with id: " + oaInvoice.id + ", Customer name: " + customer.name);
            NSOA.meta.log("error", "Error creating creditMemo ");
        } else {
            logFile.add("Invoice created - id: " + response2.body.Invoice.Id);
            var returnedInvoice2 = {
                "id": response2.body.Invoice.Id
            };
            returnID = response2.body.Invoice.Id;

            exportSlips(slips);

        }
    }




    return returnID;
}

async function getPayments(qb_base_url, qb_company_id, lastRun, logFile, errorLogFile) {

    var QB_Lib = require("QB_Lib");

    var tsLib = require("tsLib_4");

    var select = "query?query=select * from Payment Where Metadata.LastUpdatedTime>'" + lastRun + "' Order By Metadata.LastUpdatedTime";

    //console.log("Invoice created " + JSON.stringify(qbInvoice));
    var url = qb_base_url + "v3/company/" + qb_company_id + "/" + select;
    // var url = "https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365218828440/" + select;
    var header = QB_Lib.get_auth_header();

    console.log("Auth header " + JSON.stringify(header));
    console.log("URL " + url);

    var response = NSOA.https.get({
        url: url,
        headers: header
    });

    console.log("payment " + JSON.stringify(response));
    console.log("Query Response " + JSON.stringify(response.body.QueryResponse));
    console.log("Payment " + JSON.stringify(response.body.QueryResponse.Payment));
    console.log("Payment type of " + typeof (response.body.QueryResponse.Payment));

    var payments = [];
    payments = response.body.QueryResponse.Payment;

    // console.log("Payments length " + payments.length);
    if (typeof (response.body.QueryResponse.Payment) !== "undefined") {
        for (var i = 0; i < payments.length; i++) {
            console.log("Payment line length " + response.body.QueryResponse.Payment[i].Line.length);
            for (var j = 0; j < response.body.QueryResponse.Payment[i].Line.length; j++) {
                console.log("Type of Linked transaction " + typeof (response.body.QueryResponse.Payment[i].Line[j].LinkedTxn));
                if (typeof (response.body.QueryResponse.Payment[i].Line[j].LinkedTxn) !== "undefined") {
                    console.log(typeof (response.body.QueryResponse.Payment[i].Line[j].LinkedTxn));

                    console.log(response.body.QueryResponse.Payment[i].Line[j].Amount + " " + JSON.stringify(response.body.QueryResponse.Payment[i].Line[j].LinkedTxn[0]));

                    console.log(response.body.QueryResponse.Payment[i].Line[j].Amount + " " + response.body.QueryResponse.Payment[i].Line[j].LinkedTxn[0].TxnId);

                    console.log("Payment ");

                    var payCust = new NSOA.record.oaCustomer();
                    payCust.qb_client_id__c = response.body.QueryResponse.Payment[i].CustomerRef.value;

                    console.log(" Looking for customer " + JSON.stringify(payCust));


                    var rcustReturn = tsLib.getRecords(payCust, "Customer", 1);

                    console.log("Returned Customer Record " + JSON.stringify(rcustReturn));

                    // if (rcustReturn !== null) {

                    var invID = response.body.QueryResponse.Payment[i].Line[j].LinkedTxn[0].TxnId;

                    var isPayment = NSOA.record.oaPayment();
                    isPayment.qb_payment_id__c = response.body.QueryResponse.Payment[i].Id;
                    isPayment.qb_payment_invoice_id__c = invID;

                    console.log("is Payment " + JSON.stringify(isPayment));

                    var inv = NSOA.record.oaInvoice();
                    inv.qb_invoice_id__c = response.body.QueryResponse.Payment[i].Line[j].LinkedTxn[0].TxnId;
                    console.log("geting invoice with external id " + inv.qb_invoice_id__c);
                    var invReturned = tsLib.getRecords(inv, "Invoice", 1);
                    console.log("Invoice returned " + JSON.stringify(invReturned));
                    if (invReturned !== null) {
                        console.log("Getting Payment " + JSON.stringify(isPayment));
                        var oapayments = tsLib.getRecords(isPayment, "Payment", 1);
                        console.log("Payment returned " + JSON.stringify(oapayments));
                        if (oapayments === null) {
                            console.log("Applying payment");
                            var addPayment = new NSOA.record.oaPayment();
                            addPayment.customerid = invReturned[0].customerid;
                            addPayment.total = response.body.QueryResponse.Payment[i].Line[j].Amount;
                            addPayment.qb_payment_id__c = response.body.QueryResponse.Payment[i].Id;
                            addPayment.qb_payment_invoice_id__c = invID;
                            addPayment.currency = response.body.QueryResponse.Payment[i].CurrencyRef.value;
                            addPayment.date = response.body.QueryResponse.Payment[i].TxnDate;
                            addPayment.notes = "Created From Quickbooks Integration";
                            addPayment.invoiceid = invReturned[0].id;


                            console.log("Adding Paymnet " + JSON.stringify(addPayment));

                            var addResults = NSOA.wsapi.add([addPayment]);

                            console.log("Results " + JSON.stringify(addResults));
                            if (addResults[0].status !== "A") {
                                NSOA.meta.log('error', "Error adding Payment " + JSON.stringify(addPayment));
                            } else {
                                logFile.add("Payment Added " + JSON.stringify(addPayment));
                            }
                        } else {
                            console.log("Payment Found " + response.body.QueryResponse.Payment[i].Id);
                        }
                    } else {
                        console.log("No Invoice for for transaction " + response.body.QueryResponse.Payment[i].Line[j].LinkedTxn[0].TxnId);

                        errorLogFile.add("No Invoice found for Transaction with ID " + response.body.QueryResponse.Payment[i].Line[j].LinkedTxn[0].TxnId);
                    }

                    /*    } else {

                        errorLogFile.add("A payment was received but the customer was not found ");
                    } */
                } else {
                    processDeletePayment();
                }
            }
        }
    }
}


async function getCreditMemos(qb_base_url, qb_company_id, lastRun, logFile, errorLogFile) {

    var QB_Lib = require("QB_Lib");
    var tsLib = require("tsLib_4");

    //  var select = "query?query=select * from Payment Where Metadata.LastUpdatedTime>'2022-06-10' Order By Metadata.LastUpdatedTime";
    var select = "query?query=Select * from CreditMemo where Metadata.LastUpdatedTime > '" + lastRun + "' Order By Metadata.LastUpdatedTime";
    //var select = "query?query=select * from Payment Where Metadata.LastUpdatedTime>'" + lastRun +"' Order By Metadata.LastUpdatedTime";

    var url = qb_base_url + "v3/company/" + qb_company_id + "/" + select;
    var header = QB_Lib.get_auth_header();

    console.log("Auth header " + JSON.stringify(header));
    console.log("URL " + url);

    var response = NSOA.https.get({
        url: url,
        headers: header
    });

    console.log("CreditMemo " + JSON.stringify(response));
    console.log("Query Response " + JSON.stringify(response.body.QueryResponse));
    //console.log("CreditMemo Detail " + JSON.stringify(response.body.QueryResponse.CreditMemo));

    // console.log("CreditMemo 0 " + JSON.stringify(response.body.QueryResponse.CreditMemo[0]));

    var cms = [];

    // console.log("CreditMemo length " + cms.length);
    if (typeof (response.body.QueryResponse.CreditMemo) !== "undefined") {
        cms = response.body.QueryResponse.CreditMemo;
        for (var i = 0; i < cms.length; i++) {
            if (typeof (response.body.QueryResponse.CreditMemo[i].Line[0].LinkedTxn) !== "undefined") {
                console.log(typeof (response.body.QueryResponse.CreditMemo[i].Line[0].LinkedTxn));
                console.log(response.body.QueryResponse.CreditMemo[i].Line[0].Amount + " " + JSON.stringify(response.body.QueryResponse.CreditMemo[i].Line[0].LinkedTxn[0]));
            } else {


                console.log("Retainer Credit memo ");

                var retainCust = new NSOA.record.oaCustomer();
                retainCust.qb_client_id__c = response.body.QueryResponse.CreditMemo[i].CustomerRef.value;

                console.log(" Looking for customer " + JSON.stringify(retainCust));


                var rcustReturn = tsLib.getRecords(retainCust, "Customer", 1);

                console.log("Returned Customer Record " + JSON.stringify(rcustReturn));

                if (rcustReturn !== null) {
                    var isRetainer = NSOA.record.oaPayment();
                    isRetainer.qb_payment_id__c = response.body.QueryResponse.CreditMemo[i].Id;

                    console.log("is Retainer " + JSON.stringify(isRetainer));

                    var retainers = tsLib.getRecords(isRetainer, "Payment", 1);
                    if (retainers === null) {
                        var addRetainer = new NSOA.record.oaPayment();
                        addRetainer.customerid = rcustReturn[0].id;
                        addRetainer.total = response.body.QueryResponse.CreditMemo[i].RemainingCredit;
                        addRetainer.qb_payment_id__c = response.body.QueryResponse.CreditMemo[i].Id;
                        addRetainer.currency = response.body.QueryResponse.CreditMemo[i].CurrencyRef.value;
                        addRetainer.date = response.body.QueryResponse.CreditMemo[i].TxnDate;
                        addRetainer.notes = "Created From Quickbooks Integration";
                        addRetainer.invoiceid = "0";

                        var retainerString = "";
                        retainerString = "A Retainer was created : Customer Name - " + rcustReturn.name + " Currency -" + response.body.QueryResponse.CreditMemo[i].CurrencyRef.value + " Amount - " + response.body.QueryResponse.CreditMemo[i].RemainingCredit + " QucikBooks ID : " + response.body.QueryResponse.CreditMemo[i].Id;


                        var retainerTo = NSOA.context.getParameter("retainerEmail");

                        var msg = {
                            to: [retainerTo],

                            subject: "Retainer Created in Quickbooks",
                            body: retainerString,

                        };


                        NSOA.meta.sendMail(msg);


                        console.log("Adding Retainer " + JSON.stringify(addRetainer));



                    }
                }

            }
        }
    }
}



async function updateCustomer(qb_base_url, qb_company_id, oaCustomer, log, errorLog) {

    NSOA.meta.log("debug", "Starting Update Customers " + JSON.stringify(oaCustomer));

    var QB_Lib = require("QB_Lib");

    var tsLib = require("tsLib_4");

    var qbCustomer = oaCustomer.qb_client_id__c;

    var user;

    if (oaCustomer.Initial_Client_Manager__c !== "") {
        user = NSOA.record.oaUser(oaCustomer.Initial_Client_Manager__c);
    }


    var url = qb_base_url + "v3/company/" + qb_company_id + "/customer/" + qbCustomer + "?minorversion=65";

    var header = QB_Lib.get_auth_header();

    var updateMe = false;


    var response = NSOA.https.get({
        url: url,
        headers: header
    });


    if (response.code == 200) {
        console.log("Getting QB Customer info: " + JSON.stringify(response));

        var syncToken = parseInt(response.body.Customer.SyncToken);

        syncToken = response.body.Customer.SyncToken;

        var customer = response.body.Customer;

        var updatedCustomerObject = {
            "Id": oaCustomer.qb_client_id__c,
            "sparse": true,
            "SyncToken": syncToken,
        };

        var updateBill = false;
        var updatePhone = false;

        var BillAddr = {};
        var PrimaryPhone = {};

        if (typeof (response.body.Customer) !== "undefined") {

            //   console.log("In the update process ");
            // console.log(JSON.stringify(customer));    
            if (customer.PrimaryEmailAddr) {
                if (customer.PrimaryEmailAddr.Address !== oaCustomer.addr_email && oaCustomer.addr_email !== "") {
                    //   console.log("in the first if");
                    updateMe = true;
                    var pea = {
                        Address: oaCustomer.addr_email
                    };
                    updatedCustomerObject.PrimaryEmailAddr = pea;
                }
            }
            //  NSOA.meta.log("debug", " after the ifs 1 ");

            //Adding customer name update.   3/26/2024 Robert Giordano

            if (customer.DisplayName) {
                if (customer.DisplayName !== oaCustomer.name) {
                    //   console.log("in the first if");
                    updateMe = true;
                    updatedCustomerObject.DisplayName = oaCustomer.name;
                }
            }

            if (customer.FullyQualifiedName) {
                if (customer.FullyQualifiedName !== oaCustomer.CompanyName) {
                    //   console.log("in the first if");
                    updateMe = true;
                    updatedCustomerObject.FullyQualifiedName = oaCustomer.CompanyName;
                }
            }



            if (customer.FamilyName) {
                if (customer.FamilyName !== oaCustomer.addr_last) {
                    updatedCustomerObject.FamilyName = oaCustomer.addr_last;
                    updateMe = true;
                }
            } else {
                updatedCustomerObject.FamilyName = oaCustomer.addr_last;
                updateMe = true;
            }

            if (customer.PrimaryPhone) {
                if (customer.PrimaryPhone.FreeFormNumber) {
                    if (customer.PrimaryPhone.FreeFormNumber !== oaCustomer.addr_phone) {
                        PrimaryPhone.FreeFormNumber = oaCustomer.addr_phone;
                        updateMe = true;
                        updatePhone = true;
                    }
                } else {

                    PrimaryPhone.FreeFormNumber = oaCustomer.addr_phone;
                    updateMe = true;
                    updatePhone = true;
                }
            } else {
                PrimaryPhone.FreeFormNumber = oaCustomer.addr_phone;
                updateMe = true;
                updatePhone = true;
            }

            if (customer.Notes) {
                if (customer.Notes !== user.name) {
                    updatedCustomerObject.Notes = user.name;
                }
            }

            if (customer.BillAddr) {
                if (customer.BillAddr.City) {
                    if (customer.BillAddr.City !== oaCustomer.addr_city && oaCustomer.addr_city !== "") {
                        BillAddr.City = oaCustomer.addr_city;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.City = oaCustomer.addr_city;
                    updateMe = true;
                    updateBill = true;
                }
                if (customer.BillAddr.Country) {
                    if (customer.BillAddr.Country !== oaCustomer.addr_country && oaCustomer.addr_country !== "") {
                        BillAddr.Country = oaCustomer.addr_country;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Country = oaCustomer.addr_country;
                    updateMe = true;
                    updateBill = true;
                }
                NSOA.meta.log("debug", " after the ifs 4");


                if (customer.BillAddr.Line1) {
                    if (customer.BillAddr.Line1 !== oaCustomer.addr_addr1 && oaCustomer.addr_addr1 !== "") {
                        console.log("Line 1 a");
                        BillAddr.Line1 = oaCustomer.addr_addr1;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    console.log("Line 1 b");
                    BillAddr.Line1 = oaCustomer.addr_addr1;
                    updateMe = true;
                    updateBill = true;
                }
                if (customer.BillAddr.Line2) {
                    if (customer.BillAddr.Line2 !== oaCustomer.addr_addr2 && oaCustomer.addr_addr2 !== "") {
                        BillAddr.Line2 = oaCustomer.addr_addr2;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Line2 = oaCustomer.addr_addr2;
                    updateMe = true;
                    updateBill = true;
                }
                if (customer.BillAddr.Line3) {
                    if (customer.BillAddr.Line3 !== oaCustomer.addr_addr3 && oaCustomer.addr_addr3 !== "") {
                        BillAddr.Line3 = oaCustomer.addr_addr3;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Line3 = oaCustomer.addr_addr3;
                    updateMe = true;
                    updateBill = true;
                }
                if (customer.BillAddr.Line4) {
                    if (customer.BillAddr.Line4 !== oaCustomer.addr_addr4 && oaCustomer.addr_addr4 !== "") {
                        BillAddr.Line4 = oaCustomer.addr_addr4;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Line4 = oaCustomer.addr_addr4;
                    updateMe = true;
                    updateBill = true;
                }
                if (customer.BillAddr.PostalCode) {
                    if (customer.BillAddr.PostalCode !== oaCustomer.addr_zip && oaCustomer.addr_zip !== "") {
                        BillAddr.PostalCode = oaCustomer.addr_zip;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.PostalCode = oaCustomer.addr_zip;
                    updateMe = true;
                    updateBill = true;


                }
                if (customer.BillAddr.CountrySubDivisionCode) {
                    if (customer.BillAddr.CountrySubDivisionCode !== oaCustomer.addr_state && oaCustomer.addr_state !== "") {
                        BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                    updateMe = true;
                    updateBill = true;
                }
            } else {
                console.log("In the else if no bill addr");
                BillAddr.City = oaCustomer.addr_city;
                BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                BillAddr.PostalCode = oaCustomer.addr_zip;
                BillAddr.Line1 = oaCustomer.addr_addr1;
                BillAddr.Line2 = oaCustomer.addr_addr2;
                BillAddr.Line3 = oaCustomer.addr_addr3;
                BillAddr.Line4 = oaCustomer.addr_addr4;
                BillAddr.Country = oaCustomer.addr_country;
                BillAddr.City = oaCustomer.addr_city;
                updateMe = true;
                updateBill = true;
            }
            console.log("Update Bill ");
            if (updateBill) {
                BillAddr.City = oaCustomer.addr_city;
                BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                BillAddr.PostalCode = oaCustomer.addr_zip;
                BillAddr.Line1 = oaCustomer.addr_addr1;
                BillAddr.Line2 = oaCustomer.addr_addr2;
                BillAddr.Line3 = oaCustomer.addr_addr3;
                BillAddr.Line4 = oaCustomer.addr_addr4;
                BillAddr.Country = oaCustomer.addr_country;
                BillAddr.City = oaCustomer.addr_city;
                updatedCustomerObject.BillAddr = {};
                updatedCustomerObject.BillAddr = BillAddr;
            }
            if (updatePhone) {
                updatedCustomerObject.PrimaryPhone = {};
                updatedCustomerObject.PrimaryPhone = PrimaryPhone;
            }


            //   NSOA.meta.log("debug", " Sending Update " + JSON.stringify(updatedCustomerObject));

            if (updateMe) {
                var postUrl = qb_base_url + "v3/company/" + qb_company_id + "/customer?minorversion=65";

                var post = NSOA.https.post({
                    url: postUrl,
                    headers: header,
                    body: updatedCustomerObject
                });

                console.log("Customer update response: " + JSON.stringify(post));

                if (post.code !== 200) {
                    errorLog.add("Error updating vendor in Quickbooks: " + oaCustomer.name);
                    NSOA.meta.log("error", "Error updating customer.");
                } else {

                    log.add("Updated customer: " + post.body.Customer.DisplayName);
                }

            }
        } else {
            console.log("Customer Undefined ");
        }
    } else {
        console.log("Error retrieving customer data for customer : " + oaCustomer.qb_client_id__c + " Customer Name " + oaCustomer.name + " " + JSON.stringify(response));

    }
    return;

}

async function updateProject(qb_base_url, qb_company_id, oaProject, logFile, errorLogFile) {

    var QB_Lib = require("QB_Lib");

    var tsLib = require("tsLib_4");

    var updateMe = false;

    var qbProject = oaProject.qb_project_id__c;

    //var oaCustomer = new NSOA.record.oaCustomer(oaProject.customerid);

    var user;

    var oaCustomer = new NSOA.record.oaCustomer(oaProject.customerid);

    var cust = new NSOA.record.oaCustomer(oaProject.customerid);
    if (cust.Initial_Client_Manager__c !== "") {
        user = NSOA.record.oaUser(cust.Initial_Client_Manager__c);
    }


    //   console.log("Customer found from project " + oaCustomer.company);

    var url = qb_base_url + "v3/company/" + qb_company_id + "/customer/" + qbProject + "?minorversion=65";

    var header = QB_Lib.get_auth_header();

    //  console.log("Auth header " + JSON.stringify(header));
    //  console.log("URL " + url);

    var response = NSOA.https.get({
        url: url,
        headers: header
    });

    //  console.log("Getting QB Project info: " + JSON.stringify(response.body.QueryResponse.Customer));
    //  console.log("Vendor type of: " + typeof (response.body.QueryResponse.Customer));
    if (response.code == 200) {
        var project = response.body.Customer;

        console.log("Project response " + JSON.stringify(project));

        var syncToken = parseInt(response.body.Customer.SyncToken);

        syncToken = response.body.Customer.SyncToken;

        var updatedProjectObject = {
            "Id": oaProject.qb_project_id__c,
            "sparse": "true",
            "SyncToken": syncToken,
        };

        var updateBill = false;
        var updatePhone = false;
        var BillAddr = {};
        var PrimaryPhone = {};

        if (typeof (response.body.Customer) !== "undefined") {

            if (project.PrimaryEmailAddr) {
                if (project.PrimaryEmailAddr.Address !== oaCustomer.addr_email && oaCustomer.addr_email !== "") {
                    // console.log("in the first if");
                    updateMe = true;
                    var pea = {
                        Address: oaCustomer.addr_email
                    };
                    updatedProjectObject.PrimaryEmailAddr = pea;
                }
            }
            //   NSOA.meta.log("debug", " after the ifs 1 ");
            if (project.FamilyName) {
                if (project.FamilyName !== oaCustomer.addr_last) {
                    updatedProjectObject.FamilyName = oaCustomer.addr_last;
                    updateMe = true;
                }
            } else {
                if (oaCustomer.addr_last !== "") {
                    updatedProjectObject.FamilyName = oaCustomer.addr_last;
                    updateMe = true;
                }
            }
            if (project.PrimaryPhone) {
                if (project.PrimaryPhone.FreeFormNumber) {
                    if (project.PrimaryPhone.FreeFormNumber !== oaCustomer.addr_phone) {
                        PrimaryPhone.FreeFormNumber = oaCustomer.addr_phone;
                        updateMe = true;
                        updatePhone = true;
                    }
                } else {

                    PrimaryPhone.FreeFormNumber = oaCustomer.addr_phone;
                    updateMe = true;
                    updatePhone = true;
                }
            } else {
                PrimaryPhone.FreeFormNumber = oaCustomer.addr_phone;
                updateMe = true;
                updatePhone = true;
            }

            if (project.Notes) {
                if (project.Notes !== user.name) {
                    updatedProjectObject.Notes = user.name;
                }
            }
            if (project.BillAddr) {
                if (project.BillAddr.City) {
                    if (project.BillAddr.City !== oaCustomer.oaCustomeraddr_city && oaCustomer.oaCustomeraddr_city !== "") {
                        BillAddr.City = oaCustomer.addr_city;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.City = oaCustomer.addr_city;
                    updateMe = true;
                    updateBill = true;
                }
                if (project.BillAddr.Country) {
                    if (project.BillAddr.Country !== oaCustomer.addr_country && oaCustomer.addr_country !== "") {
                        BillAddr.Country = oaCustomer.addr_country;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Country = oaCustomer.addr_country;
                    updateMe = true;
                    updateBill = true;
                }
                //   NSOA.meta.log("debug", " after the ifs 4");


                if (project.BillAddr.Line1) {
                    if (project.BillAddr.Line1 !== oaCustomer.addr_addr1 && oaCustomer.addr_addr1 !== "") {
                        BillAddr.Line1 = oaCustomer.addr_addr1;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Line1 = oaCustomer.addr_addr1;
                    updateMe = true;
                    updateBill = true;
                }
                if (project.BillAddr.Line2) {
                    if (project.BillAddr.Line2 !== oaCustomer.addr_addr2 && oaCustomer.addr_addr2 !== "") {
                        BillAddr.Line2 = oaCustomer.addr_addr2;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Line2 = oaCustomer.addr_addr2;
                    updateMe = true;
                    updateBill = true;
                }
                if (project.BillAddr.Line3) {
                    if (project.BillAddr.Line3 !== oaCustomer.addr_addr3 && oaCustomer.addr_addr3 !== "") {
                        BillAddr.Line3 = oaCustomer.addr_addr3;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Line3 = oaCustomer.addr_addr3;
                    updateMe = true;
                    updateBill = true;
                }
                if (project.BillAddr.Line4) {
                    if (project.BillAddr.Line4 !== oaCustomer.addr_addr4 && oaCustomer.addr_addr4 !== "") {
                        BillAddr.Line4 = oaCustomer.addr_addr4;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.Line4 = oaCustomer.addr_addr4;
                    updateMe = true;
                    updateBill = true;
                }
                if (project.BillAddr.PostalCode) {
                    if (project.BillAddr.PostalCode !== oaCustomer.addr_zip && oaCustomer.addr_zip !== "") {
                        BillAddr.PostalCode = oaCustomer.addr_zip;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.PostalCode = oaCustomer.addr_zip;
                    updateMe = true;
                    updateBill = true;


                }
                if (project.BillAddr.CountrySubDivisionCode) {
                    if (project.BillAddr.CountrySubDivisionCode !== oaCustomer.addr_state && oaCustomer.addr_state !== "") {
                        BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                        updateMe = true;
                        updateBill = true;
                    }
                } else {
                    BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                    updateMe = true;
                    updateBill = true;
                }
            } else {
                BillAddr.City = oaCustomer.addr_city;
                BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                BillAddr.PostalCode = oaCustomer.addr_zip;
                BillAddr.Line1 = oaCustomer.addr_addr1;
                BillAddr.Line2 = oaCustomer.addr_addr2;
                BillAddr.Line3 = oaCustomer.addr_addr3;
                BillAddr.Line4 = oaCustomer.addr_addr4;
                BillAddr.Country = oaCustomer.addr_country;
                BillAddr.City = oaCustomer.addr_city;
                updateMe = true;
                updateBill = true;
            }

            if (updateBill) {
                BillAddr.City = oaCustomer.addr_city;
                BillAddr.CountrySubDivisionCode = oaCustomer.addr_state;
                BillAddr.PostalCode = oaCustomer.addr_zip;
                BillAddr.Line1 = oaCustomer.addr_addr1;
                BillAddr.Line2 = oaCustomer.addr_addr2;
                BillAddr.Line3 = oaCustomer.addr_addr3;
                BillAddr.Line4 = oaCustomer.addr_addr4;
                BillAddr.Country = oaCustomer.addr_country;
                BillAddr.City = oaCustomer.addr_city;
                updatedProjectObject.BillAddr = {};
                updatedProjectObject.BillAddr = BillAddr;
            }
            if (updatePhone) {
                updatedProjectObject.PrimaryPhone = {};
                updatedProjectObject.PrimaryPhone = PrimaryPhone;
            }

            var postUrl = qb_base_url + "v3/company/" + qb_company_id + "/customer/?minorversion=65";



            if (updateMe) {

                console.log("Project to Update " + JSON.stringify(updatedProjectObject));

                var post = NSOA.https.post({
                    url: postUrl,
                    headers: header,
                    body: updatedProjectObject
                });

                console.log("Project update response: " + JSON.stringify(post));

                if (post.code !== 200) {
                    errorLogFile.add("Error updating project in Quickbooks: " + oaProject.name);
                    NSOA.meta.log("error", "Error updating project.");
                } else {

                    logFile.add("Updated project: " + post.body.Customer.DisplayName);
                }
            }
        }
    } else {
        NSOA.meta.log('error', "Error Updating Project " + oaProject.name + " qb id " + oaProject.qb_project_id__c + " " + JSON.stringify(response));
    }
    return;
}

async function createSumInvoiceLines(results) {

    console.log("Entering the sum invoices ");

    var line;
    var Lines = [];
    var sumArray = [];
    var tempItemSum;
    var blankSum;
    var lib = require("tsLib_4");

    //  console.log("here " + results.length);

    for (var i = 0; i < results.length; i++) {
        //  console.log("running though the slips " + i);
        tempItemSum = new itemSum();
        tempItemSum.oaItemID = results[i].categoryid;
        blankSum = lib.objArrayFind(sumArray, tempItemSum);
        //   console.log("Summ array " + JSON.stringify(blankSum));
        if (blankSum) {
            //   console.log("Blank " + JSON.stringify(results[i]));
            try {
                var tempTot = parseFloat(results[i].total);
                //   console.log("temp Tot " + tempTot);
                blankSum.sum += parseFloat(results[i].total);
                //   console.log("xxxx ");
            } catch (e) {
                console.log("error caught " + JSON.stringify(e));
            }
            //  console.log("234 ");
            blankSum.count = blankSum.count + 1;
            // console.log("456 ");
            if (results[i].type == "T") {

                blankSum.hours += parseFloat(results[i].decimal_hours);
                // console.log("9089 ");
            }
        } else {

            //console.log("Not Blank ");

            tempItemSum.sum = parseFloat(results[i].total);
            tempItemSum.count = 1;
            tempItemSum.hours = parseFloat(results[i].decimal_hours);
            tempItemSum.type = results[i].type;

            // console.log("23 " + JSON.stringify(tempItemSum));
            var getItem = new NSOA.record.oaCategory();
            getItem.id = results[i].categoryid;


            var item = lib.getRecords(getItem, "Category", 1);
            if (item !== null) {
                tempItemSum.oaItemID = item[0].id;
                tempItemSum.qbItemID = item[0].externalid;
                tempItemSum.description = item[0].name;
                sumArray.push(tempItemSum);
            }

            //console.log("Ending the not blank");
        }
    }


    //  console.log("here before the sum array " + JSON.stringify(sumArray));


    for (var j = 0; j < sumArray.length; j++) {

        var qty;
        var unitPrice;

        if (sumArray[j].type == "T") {
            qty = sumArray[j].hours;
            unitPrice = sumArray[j].sum / sumArray[j].hours;

        }
        else {
            qty = sumArray[j].count;
            unitPrice = sumArray[j].sum / sumArray[j].count;
        }


        line = {
            "Description": sumArray[j].description,
            "DetailType": "SalesItemLineDetail",
            "SalesItemLineDetail": {
                "TaxCodeRef": {
                    "value": "NON"
                },
                "Qty": qty,
                "UnitPrice": unitPrice,
                "ItemRef": {
                    "name": sumArray[j].description,
                    "value": sumArray[j].qbItemID
                }
            },
            "Amount": sumArray[j].sum,

        };

        // console.log(" Line " + j + " " + JSON.stringify(line));
        Lines.push(line);
    }

    // console.log("Before the return ");
    return Lines;
}

async function itemSum() {
    var oaItemID = "";
    var qbItemID = "";
    var sum = 0.0;
    var count = 0;
    var description = "";
    var hours = 0.0;
    var type = "";
}


async function exportSlips(slips) {

    var lib = require("tsLib_4");

    var today = new Date();

    var todayString = lib.getDateString(today, "yyyy-MM-dd");

    for (var i = 0; i < slips.length; i++) {
        var ie = new NSOA.record.oaImportExport();
        ie.id = slips[i].id;
        ie.applicaton = "quickbooks";
        ie.exported = todayString;
        ie.type = "Slip";

       

        var ieReturn = NSOA.wsapi.add([ie]);

        if (ieReturn[0].status !== "A") {
            console.log("Error Exporting for invoice " + slips[i].invoiceid);
        }

       

    }
}
