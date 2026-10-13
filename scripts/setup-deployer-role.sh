#!/usr/bin/env bash
# One-time AWS admin setup for a least-privilege PlayAgent deployer.
# Run it once in AWS CloudShell (or any shell with admin credentials):
#   git clone https://github.com/hoycdanny/playagent-checker.git && bash playagent-checker/scripts/setup-deployer-role.sh
# It is safe to re-run. It:
#   1. CDK-bootstraps the account/region if CDKToolkit is missing (the only step that needs admin);
#   2. creates/updates the customer-managed policy PlayAgentDeployer from infra/iam/playagent-deployer-policy.json;
#   3. creates the EC2 role + instance profile playagent-deployer (PlayAgentDeployer + AmazonSSMManagedInstanceCore).
# Env overrides: AWS_REGION (us-east-2), PLAYAGENT_ROLE_NAME (playagent-deployer), PLAYAGENT_POLICY_NAME (PlayAgentDeployer).
set -euo pipefail

REGION="${AWS_REGION:-us-east-2}"
ROLE="${PLAYAGENT_ROLE_NAME:-playagent-deployer}"
POLICY="${PLAYAGENT_POLICY_NAME:-PlayAgentDeployer}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POLICY_FILE="$HERE/../infra/iam/playagent-deployer-policy.json"

[[ "$REGION" =~ ^[a-z]{2}(-[a-z]+)+-[0-9]$ ]] || { echo "Invalid AWS_REGION: $REGION" >&2; exit 1; }
[[ "$ROLE" =~ ^[A-Za-z0-9+=,.@_-]{1,64}$ && "$POLICY" =~ ^[A-Za-z0-9+=,.@_-]{1,128}$ ]] || { echo "Invalid role/policy name" >&2; exit 1; }
[[ -f "$POLICY_FILE" ]] || { echo "Missing $POLICY_FILE" >&2; exit 1; }

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
[[ "$ACCOUNT" =~ ^[0-9]{12}$ ]] || { echo "Could not resolve AWS account" >&2; exit 1; }
echo "==> Account $ACCOUNT / region $REGION"

# 1. CDK bootstrap (admin only, once per account/region)
STATUS="$(aws cloudformation describe-stacks --region "$REGION" --stack-name CDKToolkit --query 'Stacks[0].StackStatus' --output text 2>/dev/null || echo MISSING)"
if [[ "$STATUS" == MISSING ]]; then
  echo "==> CDKToolkit missing: running cdk bootstrap"
  npx -y aws-cdk@2 bootstrap "aws://$ACCOUNT/$REGION"
elif [[ ! "$STATUS" =~ ^(CREATE|UPDATE|UPDATE_ROLLBACK)_COMPLETE$ ]]; then
  echo "CDKToolkit is $STATUS; fix it in the CloudFormation console first." >&2; exit 1
else
  echo "==> CDKToolkit already $STATUS"
fi

# 2. Customer-managed policy (account and region substituted into the template)
DOC="$(sed -e "s/<ACCOUNT_ID>/$ACCOUNT/g" -e "s/us-east-2/$REGION/g" "$POLICY_FILE")"
POLICY_ARN="arn:aws:iam::$ACCOUNT:policy/$POLICY"
if aws iam get-policy --policy-arn "$POLICY_ARN" >/dev/null 2>&1; then
  OLD="$(aws iam list-policy-versions --policy-arn "$POLICY_ARN" --query 'Versions[?IsDefaultVersion==`false`].VersionId' --output text)"
  COUNT="$(wc -w <<<"$OLD")"
  if (( COUNT >= 4 )); then
    OLDEST="$(tr '\t ' '\n\n' <<<"$OLD" | sed 's/^v//' | sort -n | head -1)"
    aws iam delete-policy-version --policy-arn "$POLICY_ARN" --version-id "v$OLDEST"
  fi
  aws iam create-policy-version --policy-arn "$POLICY_ARN" --policy-document "$DOC" --set-as-default >/dev/null
  echo "==> Updated policy $POLICY"
else
  aws iam create-policy --policy-name "$POLICY" --description "Least-privilege PlayAgent Checker installer" --policy-document "$DOC" >/dev/null
  echo "==> Created policy $POLICY"
fi

# 3. EC2 role + instance profile
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-role --role-name "$ROLE" --assume-role-policy-document "$TRUST" --description "PlayAgent Checker deployer (EC2)" >/dev/null
  echo "==> Created role $ROLE"
fi
aws iam attach-role-policy --role-name "$ROLE" --policy-arn "$POLICY_ARN"
aws iam attach-role-policy --role-name "$ROLE" --policy-arn arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" >/dev/null 2>&1; then
  aws iam create-instance-profile --instance-profile-name "$ROLE" >/dev/null
fi
if ! aws iam get-instance-profile --instance-profile-name "$ROLE" --query 'InstanceProfile.Roles[].RoleName' --output text | grep -qx "$ROLE"; then
  aws iam add-role-to-instance-profile --instance-profile-name "$ROLE" --role-name "$ROLE"
fi

echo
echo "Done. Launch the EC2 instance with IAM instance profile: $ROLE"
echo "To use the same rights from a laptop/SSO instead, attach policy $POLICY to that user or permission set."
