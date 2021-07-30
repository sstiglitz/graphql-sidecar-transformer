import { AppSync, Fn, IAM } from 'cloudform-types'
import { DirectiveNode, ObjectTypeDefinitionNode } from 'graphql'
import {
  compoundExpression,
  iff,
  obj,
  printBlock,
  qref,
  raw,
  ref,
  str,
} from 'graphql-mapping-template'
import {
  FunctionResourceIDs,
  plurality,
  ResourceConstants,
} from 'graphql-transformer-common'
import {
  getDirectiveArguments,
  gql,
  InvalidDirectiveError,
  Transformer,
  TransformerContext,
} from 'graphql-transformer-core'

const SIDECAR_DIRECTIVE_STACK = 'FunctionDirectiveStack'

const lambdaArnKey = (name: string, region?: string) => {
  return region
    ? `arn:aws:lambda:${region}:\${AWS::AccountId}:function:${name}`
    : `arn:aws:lambda:\${AWS::Region}:\${AWS::AccountId}:function:${name}`
}

const referencesEnv = (value: string) => {
  return value.match(/(\${env})/) !== null
}

const removeEnvReference = (value: string) => {
  return value.replace(/(-\${env})/, '')
}

const lambdaArnResource = (name: string, region?: string) => {
  const substitutions: any = {}
  if (referencesEnv(name)) {
    substitutions['env'] = Fn.Ref(ResourceConstants.PARAMETERS.Env)
  }
  return Fn.If(
    ResourceConstants.CONDITIONS.HasEnvironmentParameter,
    Fn.Sub(lambdaArnKey(name, region), substitutions),
    Fn.Sub(lambdaArnKey(removeEnvReference(name), region), {}),
  )
}

/**
 * Handles the @sidecar directive on OBJECT types.
 */
export class SidecarTransformer extends Transformer {
  constructor() {
    super(
      `graphql-sidecar-transform`,
      gql`
        directive @sidecar(name: String!, region: String) on OBJECT
      `,
    )
  }

  /**
   * Given the initial input and context manipulate the context to handle this object directive.
   * @param definition
   * @param directive
   * @param ctx The accumulated context for the transform.
   */
  // @ts-ignore
  public object = (
    definition: ObjectTypeDefinitionNode,
    directive: DirectiveNode,
    ctx: TransformerContext,
  ): void => {
    this.validateObject(definition)

    const { sidecarLambdaFunctionId, sidecarLambdaDataSourceName } =
      this.createLambdaFunctionResources(directive, ctx)

    this.createSidecarResolver(
      ctx,
      sidecarLambdaFunctionId,
      sidecarLambdaDataSourceName,
      'Mutation',
      `create${definition.name.value}`,
    )
    this.createSidecarResolver(
      ctx,
      sidecarLambdaFunctionId,
      sidecarLambdaDataSourceName,
      'Mutation',
      `update${definition.name.value}`,
    )
    this.createSidecarResolver(
      ctx,
      sidecarLambdaFunctionId,
      sidecarLambdaDataSourceName,
      'Mutation',
      `delete${definition.name.value}`,
    )
    this.createSidecarResolver(
      ctx,
      sidecarLambdaFunctionId,
      sidecarLambdaDataSourceName,
      'Query',
      `get${definition.name.value}`,
    )
    this.createSidecarResolver(
      ctx,
      sidecarLambdaFunctionId,
      sidecarLambdaDataSourceName,
      'Query',
      plurality(`list${definition.name.value}`, true),
    )
  }

  private validateObject = (definition: ObjectTypeDefinitionNode) => {
    const direcectives = definition.directives
    if (!direcectives) {
      throw new InvalidDirectiveError('Type does not have any directives.')
    }

    const modelDirective = direcectives.find(
      (dir) => dir.name.value === 'model',
    )
    if (!modelDirective) {
      throw new InvalidDirectiveError(
        'Types annotated with @sidecar must also be annotated with @model.',
      )
    }
  }

  private createLambdaFunctionResources = (
    directive: DirectiveNode,
    ctx: TransformerContext,
  ) => {
    const { name, region } = getDirectiveArguments(directive)

    // create new IAM role to execute firehose lambda if not yet existing
    const iamRoleId = FunctionResourceIDs.FunctionIAMRoleID(name, region)
    if (!ctx.getResource(iamRoleId)) {
      ctx.setResource(
        iamRoleId,
        new IAM.Role({
          RoleName: Fn.If(
            ResourceConstants.CONDITIONS.HasEnvironmentParameter,
            Fn.Join('-', [
              FunctionResourceIDs.FunctionIAMRoleName(name, true),
              Fn.GetAtt(
                ResourceConstants.RESOURCES.GraphQLAPILogicalID,
                'ApiId',
              ),
              Fn.Ref(ResourceConstants.PARAMETERS.Env),
            ]),
            Fn.Join('-', [
              FunctionResourceIDs.FunctionIAMRoleName(name, false),
              Fn.GetAtt(
                ResourceConstants.RESOURCES.GraphQLAPILogicalID,
                'ApiId',
              ),
            ]),
          ),
          AssumeRolePolicyDocument: {
            Version: '2012-10-17',
            Statement: [
              {
                Effect: 'Allow',
                Principal: {
                  Service: 'appsync.amazonaws.com',
                },
                Action: 'sts:AssumeRole',
              },
            ],
          },
          Policies: [
            {
              PolicyName: 'InvokeLambdaFunction',
              PolicyDocument: {
                Version: '2012-10-17',
                Statement: [
                  {
                    Effect: 'Allow',
                    Action: ['lambda:InvokeFunction'],
                    Resource: lambdaArnResource(name, region),
                  },
                ],
              },
            },
          ],
        }),
      )
      ctx.mapResourceToStack(SIDECAR_DIRECTIVE_STACK, iamRoleId)
    }

    // create new lambda datasource for sidecar lambda if not yet existing
    const sidecarLambdaDataSourceName =
      FunctionResourceIDs.FunctionDataSourceID(name, region)
    if (!ctx.getResource(sidecarLambdaDataSourceName)) {
      ctx.setResource(
        sidecarLambdaDataSourceName,
        new AppSync.DataSource({
          ApiId: Fn.GetAtt(
            ResourceConstants.RESOURCES.GraphQLAPILogicalID,
            'ApiId',
          ),
          Name: sidecarLambdaDataSourceName,
          Type: 'AWS_LAMBDA',
          ServiceRoleArn: Fn.GetAtt(iamRoleId, 'Arn'),
          LambdaConfig: {
            LambdaFunctionArn: lambdaArnResource(name, region),
          },
        }).dependsOn(iamRoleId),
      )
      ctx.mapResourceToStack(
        SIDECAR_DIRECTIVE_STACK,
        sidecarLambdaDataSourceName,
      )
    }

    // create the sidecar lambda if not yet existing
    const sidecarLambdaFunctionId =
      FunctionResourceIDs.FunctionAppSyncFunctionConfigurationID(name, region)
    if (!ctx.getResource(sidecarLambdaFunctionId)) {
      ctx.setResource(
        sidecarLambdaFunctionId,
        new AppSync.FunctionConfiguration({
          ApiId: Fn.GetAtt(
            ResourceConstants.RESOURCES.GraphQLAPILogicalID,
            'ApiId',
          ),
          Name: sidecarLambdaFunctionId,
          DataSourceName: sidecarLambdaDataSourceName,
          FunctionVersion: '2018-05-29',
          RequestMappingTemplate: printBlock(
            `Invoke AWS Lambda data source: ${sidecarLambdaDataSourceName}`,
          )(
            obj({
              version: str('2018-05-29'),
              operation: str('Invoke'),
              payload: obj({
                typeName: str('$ctx.stash.get("typeName")'),
                fieldName: str('$ctx.stash.get("fieldName")'),
                arguments: ref('util.toJson($ctx.arguments)'),
                identity: ref('util.toJson($ctx.identity)'),
                source: ref('util.toJson($ctx.source)'),
                request: ref('util.toJson($ctx.request)'),
                prev: ref('util.toJson($ctx.prev)'),
              }),
            }),
          ),
          ResponseMappingTemplate: printBlock('Handle error or return result')(
            compoundExpression([
              iff(
                ref('ctx.error'),
                raw('$util.error($ctx.error.message, $ctx.error.type)'),
              ),
              raw('$util.toJson($ctx.result)'),
            ]),
          ),
        }).dependsOn(sidecarLambdaDataSourceName),
      )
      ctx.mapResourceToStack(SIDECAR_DIRECTIVE_STACK, sidecarLambdaFunctionId)
    }

    return { sidecarLambdaFunctionId, sidecarLambdaDataSourceName }
  }

  private createSidecarResolver = (
    ctx: TransformerContext,
    sidecarLambdaFunctionId: string,
    sidecarLambdaDataSourceName: string,
    typeName: string,
    fieldName: string,
  ) => {
    const fieldNameFirstletterUppercase =
      fieldName[0].toUpperCase() + fieldName.substring(1)

    // create a new sidecar resolver and attach the sidecar functions
    const sidecarResolverId = `${typeName}${fieldNameFirstletterUppercase}SidecarResolver`
    ctx.setResource(
      sidecarResolverId,
      new AppSync.Resolver({
        ApiId: Fn.GetAtt(
          ResourceConstants.RESOURCES.GraphQLAPILogicalID,
          'ApiId',
        ),
        TypeName: typeName,
        FieldName: fieldName,
        Kind: 'UNIT',
        DataSourceName: sidecarLambdaDataSourceName,
        RequestMappingTemplate: printBlock('Stash resolver specific context.')(
          compoundExpression([
            qref(`$ctx.stash.put("typeName", "${typeName}")`),
            qref(`$ctx.stash.put("fieldName", "${fieldName}")`),
            obj({}),
          ]),
        ),
        ResponseMappingTemplate: '$util.toJson($ctx.result)',
      }).dependsOn([sidecarLambdaFunctionId]),
    )
    ctx.mapResourceToStack(SIDECAR_DIRECTIVE_STACK, sidecarResolverId)
  }
}
