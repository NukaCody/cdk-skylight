/**
 *  Copyright 2021 Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import {
	aws_autoscaling,
	aws_ec2,
	aws_eks,
	aws_iam,
	aws_secretsmanager,
	aws_ssm,
	CfnResource,
} from "aws-cdk-lib";
import { AutoScalingGroup } from "aws-cdk-lib/aws-autoscaling";
import { Construct } from "constructs";

export interface runtimeNodes {
	/**
	 * Method to add userData to the nodes
	 */
	addUserData(...commands: string[]): void;
	/**
	 * Method to configure the Nodes to part of AD Domain
	 * Secret: The secrets manager secret to use must be in format:
	 * '{Domain: <domain.name>, UserID: 'Admin', Password: '<password>'}' (From cdk-skylight.AdAuthentication Object)
	 */
	addAdDependency?(secret: aws_secretsmanager.ISecret): void;
	/**
	 * Method to configure persistent storage dependency to the hosts
	 */
	addStorageDependency(
		secret: aws_secretsmanager.ISecret,
		storageEndpoint: string
	): void;

	/**
	 * Method to add the nodes to specific Cluster
	 */
	addEKSDependency?(eksCluster: aws_eks.Cluster): void;

	/**
	 * Method to add support for LocalCredFile
	 */
	addLocalCredFile?(
		secret: aws_secretsmanager.ISecret,
		ADGroupName: string,
		AccountName: string
	): void;
}

export class WindowsEKSNodes extends Construct implements runtimeNodes {
	readonly asg: AutoScalingGroup;
	readonly windows_workers_role: aws_iam.Role;
	readonly asg_resource: aws_autoscaling.CfnAutoScalingGroup;

	constructor(
		scope: Construct,
		id: string,
		vpc: aws_ec2.IVpc,
		instanceType: aws_ec2.InstanceType
	) {
		super(scope, id);
		const windows_machineImage = new aws_ec2.LookupMachineImage({
			name: "*Windows_Server-2019-English-Full-EKS_Optimized-1.21*",
			windows: true,
		});

		const eks_security_group = new aws_ec2.SecurityGroup(
			this,
			id + "-securityGroup",
			{
				vpc: vpc,
			}
		);
		this.windows_workers_role = new aws_iam.Role(
			this,
			"windows-eks-workers-instance-role",
			{
				assumedBy: new aws_iam.ServicePrincipal("ec2.amazonaws.com"),
				roleName: "windows-eks-workers-instance-role",
				managedPolicies: [
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"AmazonSSMManagedInstanceCore"
					),
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"AmazonEKSWorkerNodePolicy"
					),
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"AmazonEC2ContainerRegistryReadOnly"
					),
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"AmazonEKS_CNI_Policy"
					),
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"AmazonSSMDirectoryServiceAccess"
					),
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"AWSKeyManagementServicePowerUser"
					),
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"AmazonEKSClusterPolicy"
					),
					aws_iam.ManagedPolicy.fromAwsManagedPolicyName(
						"SecretsManagerReadWrite"
					),
				],
			}
		);

		this.asg = new aws_autoscaling.AutoScalingGroup(
			this,
			"WindowsInstancesCapacity",
			{
				vpc: vpc,
				role: this.windows_workers_role,
				minCapacity: 2,
				securityGroup: eks_security_group,
				maxCapacity: 10,
				instanceType: instanceType,
				machineImage: windows_machineImage,
			}
		);

		this.asg_resource = this.asg.node.children.find(
			(c) =>
				(c as CfnResource).cfnResourceType ===
				"AWS::AutoScaling::AutoScalingGroup"
		) as aws_autoscaling.CfnAutoScalingGroup;
	}

	addUserData(...commands: string[]) {
		this.asg.addUserData(...commands);
	}

	addAdDependency(secret: aws_secretsmanager.ISecret) {
		this.addUserData(`
			#domain join with secret from secret manager
			[string]$SecretAD  = "${secret.secretName}"
			$SecretObj = Get-SECSecretValue -SecretId $SecretAD
			[PSCustomObject]$Secret = ($SecretObj.SecretString  | ConvertFrom-Json)
			$password   = $Secret.Password | ConvertTo-SecureString -asPlainText -Force
			$username   = $Secret.UserID + "@" + $Secret.Domain
			$credential = New-Object System.Management.Automation.PSCredential($username,$password)
			Add-Computer -DomainName $Secret.Domain -Credential $credential
			Restart-Computer -Force
		`);
	}

	runPowerShellSSMDocument(name: string, commands: string[]) {
		new aws_ssm.CfnAssociation(this, name, {
			name: "AWS-RunPowerShellScript",
			parameters: {
				commands: commands,
			},
			targets: [
				{
					key: "tag:aws:autoscaling:groupName",
					values: [this.asg.autoScalingGroupName],
				},
			],
		});
	}

	addStorageDependency(
		secret: aws_secretsmanager.ISecret,
		storageEndpoint: string
	) {
		const commands = [
			"$bootfix = {",
			"$LocalDrive = Get-SmbGlobalMapping",
			"if ($LocalDrive -eq $null)",
			"{",
			` [string]$SecretAD  = '${secret.secretName}'`,
			" $SecretObj = Get-SECSecretValue -SecretId $SecretAD",
			" [PSCustomObject]$Secret = ($SecretObj.SecretString  | ConvertFrom-Json)",
			" $password   = $Secret.Password | ConvertTo-SecureString -asPlainText -Force",
			" $username   = $Secret.UserID + '@' + $Secret.Domain",
			" $domain_admin_credential = New-Object System.Management.Automation.PSCredential($username,$password)",
			` New-SmbGlobalMapping -RemotePath '${storageEndpoint}' -Credential $domain_admin_credential -LocalPath G: -Persistent $true -RequirePrivacy $true -ErrorAction Stop`,
			"}",
			"}",
			"New-Item -ItemType Directory -Path c:\\Scripts",
			"$bootfix | set-content c:\\Scripts\\bootfix.ps1",
			"# Create a scheduled task on startup to execute the mapping",
			"$action = New-ScheduledTaskAction -Execute 'Powershell.exe' -Argument 'c:\\scripts\\bootfix.ps1'",
			"$trigger =  New-ScheduledTaskTrigger -AtStartup",
			"Register-ScheduledTask -Action $action -Trigger $trigger -TaskName 'SmbGlobalMapping' -Description 'Mapping the SMB share and adding machine to gMSA' -RunLevel Highest -User $username -Password $Secret.Password",
			"# Running the boot fix once",
			"& $bootfix",
			"",
		];
		this.runPowerShellSSMDocument("SMBGlobalMapping", commands);
	}

	addEKSDependency(eksCluster: aws_eks.Cluster) {
		const commands = [
			"# Joining EKS Cluster",
			"[string]$EKSBootstrapScriptFile = 'C:\\Program Files\\Amazon\\EKS\\Start-EKSBootstrap.ps1'",
			`powershell -File $EKSBootstrapScriptFile -EKSClusterName '${eksCluster.clusterName}`,
		];
		this.runPowerShellSSMDocument("EKSBootstrap", commands);
		eksCluster.awsAuth.addRoleMapping(this.windows_workers_role, {
			groups: [
				"system:bootstrappers",
				"system:nodes",
				"eks:kube-proxy-windows",
			],
			username: "system:node:{{EC2PrivateDNSName}}",
		});
		eksCluster.connectAutoScalingGroupCapacity(this.asg, {
			bootstrapEnabled: false, //Windows Bootstrap done manually
		});
	}

	addLocalCredFile(
		secret: aws_secretsmanager.ISecret,
		ADGroupName: string,
		AccountName: string
	) {
		const commands = [
			"# Getting AD Password",
			`[string]$SecretAD  = '${secret.secretName}'`,
			"$SecretObj = Get-SECSecretValue -SecretId $SecretAD",
			"[PSCustomObject]$Secret = ($SecretObj.SecretString  | ConvertFrom-Json)",
			"$password   = $Secret.Password | ConvertTo-SecureString -asPlainText -Force",
			"$username   = $Secret.UserID + '@' + $Secret.Domain",
			"$domain_admin_credential = New-Object System.Management.Automation.PSCredential($username,$password)",
			"Add-WindowsFeature RSAT-AD-PowerShell",
			"Install-PackageProvider NuGet -Force",
			"Install-Module CredentialSpec -Force",
			"Set-PSRepository PSGallery -InstallationPolicy Trusted",
			`New-ADGroup -Name "${ADGroupName} AD Group" -SamAccountName ${ADGroupName}"" -GroupScope DomainLocal -Credential $domain_admin_credential`,
			`New-ADServiceAccount -Name "${AccountName}" -DnsHostName "${AccountName}.$Secret.Domain" -ServicePrincipalNames "host/${AccountName}", "host/${AccountName}.$Secret.Domain" -PrincipalsAllowedToRetrieveManagedPassword "${ADGroupName}" -Credential $domain_admin_credential`,
			`Add-ADGroupMember -Identity '${ADGroupName}' -Members $env:computername$ -Credential $domain_admin_credential`,
			"# Saves the cred file to C:\\ProgramData\\Docker\\CredentialSpecs (default)",
			"#Here upload to S3 the CredFile",
			"$bootfix = {",
			`New-CredentialSpec -AccountName ${AccountName}`,
			"}",
			"# Scheduling onboot",
			"$trigger =  New-ScheduledTaskTrigger -AtStartup",
			"$bootfix | set-content c:\\Scripts\\gMSA.ps1",
			"$action = New-ScheduledTaskAction -Execute 'Powershell.exe' -Argument 'c:\\scripts\\gMSA.ps1'",
			"Register-ScheduledTask -Action $action -Trigger $trigger -TaskName 'CreateCredSpecFile' -Description 'CreateCredFile and saves it in default folder' -RunLevel Highest -User $username -Password $Secret.Password",
			"# Reboot to apply changes",
			"Restart-Computer -Force",
			"",
		];

		this.runPowerShellSSMDocument("gMSA_AD_Group_CredFile", commands);
	}
}