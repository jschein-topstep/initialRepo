// packages/functions/client-a-import/index.mjs
import { parseClientData } from "../../utils/sharedUtils.js";
import { parse } from "csv-parse/sync"; // Installed at monorepo root

export const handler = async (event) => {
    console.log("Lambda triggered locally with event:", event);
    
    const records = parse("foo,bar\nbaz,qux"); 
    const result = parseClientData(JSON.stringify(records));
    
    return { status: 200, body: result };
};
