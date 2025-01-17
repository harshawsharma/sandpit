/*jshint esversion: 8 */
const AWS = require('aws-sdk');

const REGION = process.env.AWS_REGION ? process.env.AWS_REGION : "us-east-1";

// RETURN NOT OK IF GIVING ERROR

const lambdaParams = {};
let paramErrors = [];
lambdaParams.deploymentRegions = process.env.DeploymentRegions ? JSON.parse(process.env.DeploymentRegions) : null;
lambdaParams.auroraGlobalClusterId = process.env.AuroraGlobalClusterId ? JSON.parse(process.env.AuroraGlobalClusterId) : null;
lambdaParams.auroraClusterArns = process.env.AuroraClusterArns ? JSON.parse(process.env.AuroraClusterArns) : null;
lambdaParams.routingControlArns = process.env.RoutingControlArns ? JSON.parse(process.env.RoutingControlArns) : null;
lambdaParams.clusterEndpoints = process.env.ClusterEndpoints ? JSON.parse(process.env.ClusterEndpoints) : null;

if (!lambdaParams.deploymentRegions) {
    paramErrors.push("DeploymentRegions");
}
if (!lambdaParams.auroraGlobalClusterId) {
    paramErrors.push("AuroraGlobalClusterId");
}
if (!lambdaParams.auroraClusterArns) {
    paramErrors.push("AuroraClusterArns");
}
if (!lambdaParams.routingControlArns) {
    paramErrors.push("RoutingControlArns");
}
if (!lambdaParams.clusterEndpoints) {
    paramErrors.push("ClusterEndpoints");
}

const rdsclient = new AWS.RDS({ region: REGION }); 
const r53rcd = {};
const eniclient = {};
const instantiateClients = () => {
    lambdaParams.deploymentRegions.forEach(deploymentRegion => {
        eniclient[deploymentRegion] = new AWS.EC2({ region: deploymentRegion });
    });

    for (let [key, value] of Object.entries(lambdaParams.clusterEndpoints)) {
        r53rcd[key] = new AWS.Route53RecoveryCluster({
            region: key,
            endpoint: value
        });
    }
};
instantiateClients();

exports.handler = async (event, context) => {
    if (paramErrors !== "") {
        console.error(`${paramErrors.join(", ")} parameters are missing, aborting`);
        return "PARAMETERS_MISSING";
    }
    try {
        console.log(`Global Cluster failover function triggered`);
        console.log(`AWS SDK Version: ${AWS.VERSION}`);
        console.log(`Context: ${JSON.stringify(context)}`);
        console.log(`Event: ${JSON.stringify(event)}`);
        
        const globalClusterStatus = await queryGlobalClusterStatus();
        //console.log(`globalClusterStatus: ${JSON.stringify(globalClusterStatus)}`);
        if (globalClusterStatus.state === "failing-over") {
            console.log("Database cluster already failing over, taking no action");
            return "DATABASE_ALREADY_FAILING_OVER";
        } else if (globalClusterStatus.state === "error") {
            console.log("Database cluster status error, taking no action");
            return "DATABASE_STATUS_ERROR";
        }

        const routingControlStates = await queryRoutingControlStates();
       
        let targetRegion = [];
        for (let [rcsRegion, rcsState] of Object.entries(routingControlStates)) {
            if (rcsState == "On") {
                targetRegion.push(rcsRegion);
            }
        }
        console.log(`targetRegion: ${targetRegion}`);

        if (targetRegion.length !== 1) {
            console.log("Target database cluster unclear, taking no action");
            return "TARGET_DATABASE_UNCLEAR";
        } else {
            if (!globalClusterStatus[lambdaParams.auroraClusterArns[targetRegion]]) {
                console.log("Database is not active in target region, initiating failover");
                const failoverRequestParams = {
                    GlobalClusterIdentifier: lambdaParams.auroraGlobalClusterId,
                    TargetDbClusterIdentifier: lambdaParams.auroraClusterArns[targetRegion]
                };
                //console.log(`failoverRequestParams: ${JSON.stringify(failoverRequestParams)}`);
    
                try {
                    const failoverResponse = await rdsclient.failoverGlobalCluster(failoverRequestParams).promise();
                    console.log(`Failover Response: ${JSON.stringify(failoverResponse)}`);
                    return "REQUESTED_FAILOVER";
                } catch (error) {
                    console.error(error);
                    return "ERROR_REQUESTING_FAILOVER";
                }

            } else {
                console.log("Database is active in target region, taking no action");
                return "NO_ACTION_REQUIRED";
            }
        }

    } catch (error) {
        console.error('Handler error '+error);
    }
    
};

const queryGlobalClusterStatus = async () => {
    const globalClusterStatus = {};
    const describeRequestParams = {
        GlobalClusterIdentifier: lambdaParams.auroraGlobalClusterId
    };
    //console.log(`describeRequestParams: ${describeRequestParams}`);
    
    try {
        const describeResponse = await rdsclient.describeGlobalClusters(describeRequestParams).promise();
        //console.log(`DescribeResponse: ${JSON.stringify(describeResponse)}`);
        
        if (describeResponse.GlobalClusters.length != 1) {
            console.error("Unexpected Global Cluster count");
            globalClusterStatus.state = "error";
        } else {
            globalClusterStatus.state = describeResponse.GlobalClusters[0].Status;
            //console.log(`GlobalClusterMembers: ${JSON.stringify(describeResponse.GlobalClusters[0].GlobalClusterMembers)}`);
            describeResponse.GlobalClusters[0].GlobalClusterMembers.forEach(member => {
                globalClusterStatus[member.DBClusterArn] = member.IsWriter;
            });
        }
    } catch (error) {
        console.error('Error querying global clusters status '+error);
        globalClusterStatus.state = "error";
    }

    //console.log(`globalClusterStatus: ${JSON.stringify(globalClusterStatus)}`);
    return globalClusterStatus;
};

const queryRoutingControlStates = async () => {
    let routingControlStates = {};
    for (let [epRegion, epURL] of Object.entries(lambdaParams.clusterEndpoints)) {
        //console.log(`queryRoutingControlStates in region ${epRegion}`);
        for (let [rcRegion, rcArn] of Object.entries(lambdaParams.routingControlArns)) {
            const getRoutingControlStateParams = {
                RoutingControlArn: rcArn
            };
            //console.log(`getRoutingControlStateParams: ${rcRegion} : ${JSON.stringify(getRoutingControlStateParams)}`);
            try {
                const getRoutingControlStateResponse = await r53rcd[epRegion].getRoutingControlState(getRoutingControlStateParams).promise();
                //console.log(`getRoutingControlStateResponse: ${JSON.stringify(getRoutingControlStateResponse)}`);
                routingControlStates[rcRegion] = getRoutingControlStateResponse.RoutingControlState;
            } catch (error) {
                console.error('getRoutingControlStateResponse Error '+error);
                routingControlStates.state = "error";
            }
        }

        if (routingControlStates.state !== "error") { break; }
    }
    
    //console.log(`routingControlStates: ${JSON.stringify(routingControlStates)}`);
    return routingControlStates;
};
