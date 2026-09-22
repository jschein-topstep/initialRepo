function getLastRefreshToken(scriptName)
{
    var lib = require("tsLib_4");
    var returnMe = "";
    var lastRunRequest=new NSOA.record.oaPreference();
    lastRunRequest.group_name="refresh_token";
    lastRunRequest.name=scriptName;
    
    NSOA.meta.log('debug', "Getting this request " + JSON.stringify(lastRunRequest));
    
    var lastRunResponse=lib.getRecords(lastRunRequest,"Preference",10);
    
    NSOA.meta.log("debug", "These are the returns " + JSON.stringify(lastRunResponse));
    
    if(lastRunResponse!==null) {
        returnMe=lastRunResponse[0].setting;
    }
    return returnMe;
    
}


function setLastRefreshToken(scriptName,token) {
    
    //var lib = require("tsLib_4");
    var lib = require("tsLib_4");
    var lastRunRequest=new NSOA.record.oaPreference();
    lastRunRequest.group_name="refresh_token";
    lastRunRequest.name=scriptName;
    
    var lastRunResponse=lib.getRecords(lastRunRequest,"Preference",10);
    
    
    NSOA.meta.log('debug', "Last runs " + JSON.stringify(lastRunResponse));

	var prefCriteria=new NSOA.record.oaPreference();
    
    if(lastRunResponse===null) {
	    prefCriteria.group_name="refresh_token";
    	prefCriteria.name=scriptName;
	    prefCriteria.setting=token;
        
        var addResults=NSOA.wsapi.add(prefCriteria);
        if(addResults[0].status!="A") {
            NSOA.meta.log("error","addErr: "+addResults[0].errors[0].code);
        } else {
            NSOA.meta.log('info', "Added " + JSON.stringify(prefCriteria));
        }

    }
    else {
       	prefCriteria.id=lastRunResponse[0].id;
	    prefCriteria.setting=token;
        prefCriteria.name=scriptName;
        prefCriteria.group_name="refresh_token";
        var modResults=NSOA.wsapi.modify([],[prefCriteria]);
        if(modResults[0].status!="U") {
            NSOA.meta.log("error","ERR: "+modResults[0].errors[0].code);
        } else {
           NSOA.meta.log('debug',"Updated refresh " + JSON.stringify(prefCriteria)); 
        }
       
    }
}

function get_auth_header()
{
 
    //var lib = 
    
    var qb_base_url = NSOA.context.getParameter("QB_Base_URL");
    
    var qb_company_id = NSOA.context.getParameter("QB_Company_ID");    
  
    var refresh_token3 = getLastRefreshToken("qb_integration");
    
    NSOA.meta.log('debug', "Refresh 3 " + refresh_token3);
        
    var bodybody = "grant_type=refresh_token&refresh_token="+refresh_token3; //AB11659220185f8RFsxLTKptZ0qf9v4CGz6mcUCw7wqdHfsSgl";
    
    // Production = Basic QUJheEw1NVVJRE5YWXhtUERVT284SUFiNTJYbXB1WnBmN095MnoyVHN1dHppOGhSUU06SEcwdzQ2Qk9nczhkem9FbTBYWktlNlRNMm1YcmF4a2ZnWGZKTlJKdg==
    // Sandbox = "Basic QUJvcDF1b0Z5SlFoaE5GRjY2d0h3NWdIQlNBTVF5RmlMZE16UEtqbFdhUVRLUEo1NTA6bVFTNDFaVkRJODR1d2x3cXhnbnZ6V1FiWUcyTThXZVlTUERmQzhqUg=="
    
    var header = {
        "Authorization" : "Basic QUJheEw1NVVJRE5YWXhtUERVT284SUFiNTJYbXB1WnBmN095MnoyVHN1dHppOGhSUU06SEcwdzQ2Qk9nczhkem9FbTBYWktlNlRNMm1YcmF4a2ZnWGZKTlJKdg==",
        "Content-Type" : "application/x-www-form-urlencoded",
        "Accept":"application/json"
    };
    
    var auth_url = "https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer";
    
    NSOA.meta.log('debug',"Auth URL " + auth_url + " Body " + JSON.stringify(bodybody) + " header " + JSON.stringify(header));
    
   var response = NSOA.https.post({
    	url: auth_url,
       	headers: header,
       	body: bodybody
});
    
    
    NSOA.meta.log('debug', "Response " + JSON.stringify(response));
    
    var access_token = response.body.access_token;
    
    var auth_header = "Bearer " + access_token;
    
    var header2 = {
       "Authorization": "Bearer " + access_token,
       "Accept":"application/json"
   };
    
    var new_refresh_token = response.body.refresh_token;
        
    setLastRefreshToken("qb_integration",new_refresh_token); 
           
    //NSOA.meta.log('debug', "Header2 " + JSON.stringify(header2));

    //var url2 = "https://sandbox-quickbooks.api.intuit.com/v3/company/4620816365218828440/query?query=select * from CompanyInfo&minorversion=63";
 
    return header2;
}

exports.setLastRefreshToken=setLastRefreshToken;
exports.getLastRefreshToken=getLastRefreshToken;
exports.get_auth_header=get_auth_header;