import {inject} from '@loopback/context';
import {repository} from '@loopback/repository';
import {
  get,
  getModelSchemaRef,
  HttpErrors,
  oas,
  param,
  patch,
  post,
  Request,
  requestBody,
  Response,
  RestBindings,
} from '@loopback/rest';
import {
  AuthenticateErrorKeys,
  CONTENT_TYPE,
  ErrorCodes,
  IAuthUserWithPermissions,
  ILogger,
  LOGGER,
  OPERATION_SECURITY_SPEC,
  STATUS_CODE,
  SuccessResponse,
  UserStatus,
} from '@sourceloop/core';
import {randomBytes} from 'crypto';
import * as jwt from 'jsonwebtoken';
import {
  authenticate,
  authenticateClient,
  AuthenticationBindings,
  AuthErrorKeys,
  ClientAuthCode,
  STRATEGY,
} from 'loopback4-authentication';
import {authorize, AuthorizeErrorKeys} from 'loopback4-authorization';
import moment from 'moment-timezone';
import {URLSearchParams} from 'url';

import {AuthServiceBindings} from '../../keys';
import {AuthClient, RefreshToken, User} from '../../models';
import {
  AuthCodeBindings,
  CodeReaderFn,
  CodeWriterFn,
  JwtPayloadFn,
} from '../../providers';
import {
  AuthClientRepository,
  RefreshTokenRepository,
  RevokedTokenRepository,
  RoleRepository,
  UserLevelPermissionRepository,
  UserLevelResourceRepository,
  UserRepository,
  UserTenantRepository,
} from '../../repositories';
import {TenantConfigRepository} from '../../repositories/tenant-config.repository';
import {AuthRefreshTokenRequest, AuthTokenRequest, LoginRequest} from './';
import {AuthUser, DeviceInfo} from './models/auth-user.model';
import {ClientAuthRequest} from './models/client-auth-request.dto';
import {ResetPassword} from './models/reset-password.dto';
import {TokenResponse} from './models/token-response.dto';

const queryGen = (from: 'body' | 'query') => {
  return (req: Request) => {
    return {
      state: `client_id=${req[from].client_id}`,
    };
  };
};

const userAgentKey = 'user-agent';

export class LoginController {
  constructor(
    @inject(AuthenticationBindings.CURRENT_CLIENT)
    private readonly client: AuthClient | undefined,
    @inject(AuthenticationBindings.CURRENT_USER)
    private readonly user: AuthUser | undefined,
    @repository(AuthClientRepository)
    public authClientRepository: AuthClientRepository,
    @repository(UserRepository)
    public userRepo: UserRepository,
    @repository(RoleRepository)
    public roleRepo: RoleRepository,
    @repository(UserLevelPermissionRepository)
    public utPermsRepo: UserLevelPermissionRepository,
    @repository(UserLevelResourceRepository)
    public userResourcesRepository: UserLevelResourceRepository,
    @repository(UserTenantRepository)
    public userTenantRepo: UserTenantRepository,
    @repository(RefreshTokenRepository)
    public refreshTokenRepo: RefreshTokenRepository,
    @repository(RevokedTokenRepository)
    public revokedTokensRepo: RevokedTokenRepository,
    @repository(TenantConfigRepository)
    public tenantConfigRepo: TenantConfigRepository,
    @inject(RestBindings.Http.REQUEST)
    private readonly req: Request,
    @inject(LOGGER.LOGGER_INJECT) public logger: ILogger,
    @inject(AuthServiceBindings.JWTPayloadProvider)
    private readonly getJwtPayload: JwtPayloadFn,
  ) {}

  @authenticateClient(STRATEGY.CLIENT_PASSWORD)
  @authenticate(STRATEGY.LOCAL)
  @authorize({permissions: ['*']})
  @post('/auth/login', {
    description:
      'Gets you the code that will be used for getting token (webapps)',
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Auth Code',
        content: {
          [CONTENT_TYPE.JSON]: Object,
        },
      },
      ...ErrorCodes,
    },
  })
  async login(
    @requestBody()
    req: LoginRequest,
  ): Promise<{
    code: string;
  }> {
    const userStatus = await this.userTenantRepo.findOne({
      where: {
        userId: this.user?.id,
      },
      fields: {
        status: true,
      },
    });
    if (!this.client || !this.user) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    } else if (!req.client_secret) {
      throw new HttpErrors.BadRequest(AuthErrorKeys.ClientSecretMissing);
    } else if (userStatus?.status === UserStatus.REGISTERED) {
      throw new HttpErrors.BadRequest('User not active yet');
    } else {
      // Do nothing and move ahead
    }
    try {
      const codePayload: ClientAuthCode<User, typeof User.prototype.id> = {
        clientId: req.client_id,
        userId: this.user.id,
      };
      const token = jwt.sign(codePayload, this.client.secret, {
        expiresIn: this.client.authCodeExpiration,
        audience: req.client_id,
        issuer: process.env.JWT_ISSUER,
        algorithm: 'HS256',
      });
      return {
        code: token,
      };
    } catch (error) {
      this.logger.error(error);
      throw new HttpErrors.Unauthorized(AuthErrorKeys.InvalidCredentials);
    }
  }

  @authenticateClient(STRATEGY.CLIENT_PASSWORD)
  @authenticate(STRATEGY.OAUTH2_RESOURCE_OWNER_GRANT)
  @authorize({permissions: ['*']})
  @post('/auth/login-token', {
    description:
      'Gets you refresh token and access token in one hit. (mobile app)',
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Token Response Model',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
      ...ErrorCodes,
    },
  })
  async loginWithClientUser(
    @requestBody() req: LoginRequest,
    @param.header.string('device_id') deviceId?: string,
  ): Promise<TokenResponse> {
    const userStatus = await this.userTenantRepo.findOne({
      where: {
        userId: this.user?.id,
      },
      fields: {
        status: true,
      },
    });
    if (!this.client || !this.user) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    } else if (
      !this.user.authClientIds ||
      this.user.authClientIds.length === 0
    ) {
      throw new HttpErrors.UnprocessableEntity(AuthErrorKeys.ClientUserMissing);
    } else if (!req.client_secret) {
      throw new HttpErrors.BadRequest(AuthErrorKeys.ClientSecretMissing);
    } else if (userStatus?.status === UserStatus.REGISTERED) {
      throw new HttpErrors.BadRequest('Your Sign-Up request is in process');
    } else {
      // Do nothing and move ahead
    }
    try {
      const payload: ClientAuthCode<User, typeof User.prototype.id> = {
        clientId: this.client.clientId,
        user: this.user,
      };

      if (
        payload.user?.id &&
        !(await this.userRepo.firstTimeUser(payload.user.id))
      ) {
        await this.userRepo.updateLastLogin(payload.user.id);
      }

      return await this.createJWT(payload, this.client, {
        deviceId,
        userAgent: this.req.headers[userAgentKey],
      });
    } catch (error) {
      this.logger.error(error);
      throw new HttpErrors.Unauthorized(AuthErrorKeys.InvalidCredentials);
    }
  }

  @authorize({permissions: ['*']})
  @post('/auth/token', {
    description:
      ' Send the code received from the above api and this api will send you refresh token and access token (webapps)',
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Token Response',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
      ...ErrorCodes,
    },
  })
  async getToken(
    @requestBody() req: AuthTokenRequest,
    @inject(AuthCodeBindings.CODEREADER_PROVIDER)
    codeReader: CodeReaderFn,
    @param.header.string('device_id') deviceId?: string,
  ): Promise<TokenResponse> {
    const authClient = await this.authClientRepository.findOne({
      where: {
        clientId: req.clientId,
      },
    });
    if (!authClient) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    }
    try {
      const code = await codeReader(req.code);
      const payload = jwt.verify(code, authClient.secret, {
        audience: req.clientId,
        issuer: process.env.JWT_ISSUER,
        algorithms: ['HS256'],
      }) as ClientAuthCode<User, typeof User.prototype.id>;

      if (
        payload.userId &&
        !(await this.userRepo.firstTimeUser(payload.userId))
      ) {
        await this.userRepo.updateLastLogin(payload.userId);
      }

      return await this.createJWT(payload, authClient, {
        deviceId,
        userAgent: this.req.headers[userAgentKey],
      });
    } catch (error) {
      this.logger.error(error);
      if (error.name === 'TokenExpiredError') {
        throw new HttpErrors.Unauthorized(AuthErrorKeys.CodeExpired);
      } else if (HttpErrors.HttpError.prototype.isPrototypeOf(error)) {
        throw error;
      } else {
        throw new HttpErrors.Unauthorized(AuthErrorKeys.InvalidCredentials);
      }
    }
  }

  @authorize({permissions: ['*']})
  @post('/auth/token-refresh', {
    description:
      ' Gets you a new access and refresh token once your access token is expired. (both mobile and web)\n',
    responses: {
      [STATUS_CODE.OK]: {
        description: 'New Token Response',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
      ...ErrorCodes,
    },
  })
  async exchangeToken(
    @requestBody() req: AuthRefreshTokenRequest,
    @param.header.string('device_id') deviceId?: string,
  ): Promise<TokenResponse> {
    const refreshPayload: RefreshToken = await this.refreshTokenRepo.get(
      req.refreshToken,
    );
    if (!refreshPayload) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.TokenExpired);
    }
    const authClient = await this.authClientRepository.findOne({
      where: {
        clientId: refreshPayload.clientId,
      },
    });
    if (!authClient) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    }
    await this.revokedTokensRepo.set(refreshPayload.accessToken, {
      token: refreshPayload.accessToken,
    });
    await this.refreshTokenRepo.delete(req.refreshToken);
    return this.createJWT(
      {clientId: refreshPayload.clientId, userId: refreshPayload.userId},
      authClient,
      {
        deviceId,
        userAgent: this.req.headers[userAgentKey],
      },
    );
  }

  @authenticateClient(STRATEGY.CLIENT_PASSWORD)
  @authenticate(
    STRATEGY.GOOGLE_OAUTH2,
    {
      accessType: 'offline',
      scope: ['profile', 'email'],
      authorizationURL: process.env.GOOGLE_AUTH_URL,
      callbackURL: process.env.GOOGLE_AUTH_CALLBACK_URL,
      clientID: process.env.GOOGLE_AUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET,
      tokenURL: process.env.GOOGLE_AUTH_TOKEN_URL,
    },
    queryGen('query'),
  )
  @authorize({permissions: ['*']})
  @oas.deprecated()
  @get('/auth/google', {
    responses: {
      [STATUS_CODE.OK]: {
        description:
          'Google Token Response (Deprecated: Possible security issue if secret is passed via query params, please use the post endpoint)',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
    },
  })
  /**
   * @deprecated This method should not be used, possible security issue if secret is passed via query params, please use the post endpoint
   */
  async loginViaGoogle(
    @param.query.string('client_id')
    clientId?: string,
    @param.query.string('client_secret')
    clientSecret?: string,
  ): Promise<void> {}

  @authenticateClient(STRATEGY.CLIENT_PASSWORD)
  @authenticate(
    STRATEGY.GOOGLE_OAUTH2,
    {
      accessType: 'offline',
      scope: ['profile', 'email'],
      authorizationURL: process.env.GOOGLE_AUTH_URL,
      callbackURL: process.env.GOOGLE_AUTH_CALLBACK_URL,
      clientID: process.env.GOOGLE_AUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET,
      tokenURL: process.env.GOOGLE_AUTH_TOKEN_URL,
    },
    queryGen('body'),
  )
  @authorize({permissions: ['*']})
  @post('/auth/google', {
    responses: {
      [STATUS_CODE.OK]: {
        description: 'POST Call for Google based login',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
    },
  })
  async postLoginViaGoogle(
    @requestBody({
      content: {
        'application/x-www-form-urlencoded': {
          schema: getModelSchemaRef(ClientAuthRequest),
        },
      },
    })
    clientCreds?: ClientAuthRequest,
  ): Promise<void> {}

  @authenticate(
    STRATEGY.GOOGLE_OAUTH2,
    {
      accessType: 'offline',
      scope: ['profile', 'email'],
      authorizationURL: process.env.GOOGLE_AUTH_URL,
      callbackURL: process.env.GOOGLE_AUTH_CALLBACK_URL,
      clientID: process.env.GOOGLE_AUTH_CLIENT_ID,
      clientSecret: process.env.GOOGLE_AUTH_CLIENT_SECRET,
      tokenURL: process.env.GOOGLE_AUTH_TOKEN_URL,
    },
    queryGen('query'),
  )
  @authorize({permissions: ['*']})
  @get('/auth/google-auth-redirect', {
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Google Redirect Token Response',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
    },
  })
  async googleCallback(
    @param.query.string('code') code: string,
    @param.query.string('state') state: string,
    @inject(RestBindings.Http.RESPONSE) response: Response,
    @inject(AuthCodeBindings.CODEWRITER_PROVIDER)
    googleCodeWriter: CodeWriterFn,
  ): Promise<void> {
    const clientId = new URLSearchParams(state).get('client_id');
    if (!clientId || !this.user) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    }
    const client = await this.authClientRepository.findOne({
      where: {
        clientId,
      },
    });
    if (!client || !client.redirectUrl) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    }
    try {
      const codePayload: ClientAuthCode<User, typeof User.prototype.id> = {
        clientId,
        user: this.user,
      };
      const token = await googleCodeWriter(
        jwt.sign(codePayload, client.secret, {
          expiresIn: client.authCodeExpiration,
          audience: clientId,
          issuer: process.env.JWT_ISSUER,
          algorithm: 'HS256',
        }),
      );
      response.redirect(`${client.redirectUrl}?code=${token}`);
    } catch (error) {
      this.logger.error(error);
      throw new HttpErrors.Unauthorized(AuthErrorKeys.InvalidCredentials);
    }
  }

  @authenticateClient(STRATEGY.CLIENT_PASSWORD)
  @authenticate(
    STRATEGY.KEYCLOAK,
    {
      host: process.env.KEYCLOAK_HOST,
      realm: process.env.KEYCLOAK_REALM, //'Tenant1',
      clientID: process.env.KEYCLOAK_CLIENT_ID, //'onboarding',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET, //'e607fd75-adc8-4af7-9f03-c9e79a4b8b72',
      callbackURL: process.env.KEYCLOAK_CALLBACK_URL, //'http://localhost:3001/auth/keycloak-auth-redirect',
      authorizationURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/auth`,
      tokenURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
      userInfoURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/userinfo`,
    },
    queryGen('body'),
  )
  @authorize({permissions: ['*']})
  @post('/auth/keycloak', {
    description: 'POST Call for keycloak based login',
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Keycloak Token Response',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
    },
  })
  async postLoginViaKeycloak(
    @requestBody({
      content: {
        'application/x-www-form-urlencoded': {
          schema: getModelSchemaRef(ClientAuthRequest),
        },
      },
    })
    clientCreds?: ClientAuthRequest,
  ): Promise<void> {}

  @authenticateClient(STRATEGY.CLIENT_PASSWORD)
  @authenticate(
    STRATEGY.KEYCLOAK,
    {
      host: process.env.KEYCLOAK_HOST,
      realm: process.env.KEYCLOAK_REALM, //'Tenant1',
      clientID: process.env.KEYCLOAK_CLIENT_ID, //'onboarding',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET, //'e607fd75-adc8-4af7-9f03-c9e79a4b8b72',
      callbackURL: process.env.KEYCLOAK_CALLBACK_URL, //'http://localhost:3001/auth/keycloak-auth-redirect',
      authorizationURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/auth`,
      tokenURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
      userInfoURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/userinfo`,
    },
    queryGen('query'),
  )
  @authorize({permissions: ['*']})
  @oas.deprecated()
  @get('/auth/keycloak', {
    responses: {
      [STATUS_CODE.OK]: {
        description:
          'Keycloak Token Response (Deprecated: Possible security issue if secret is passed via query params, please use the post endpoint)',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
    },
  })

  /**
   * @deprecated This method should not be used, possible security issue if secret is passed via query params, please use the post endpoint
   */
  async loginViaKeycloak(
    @param.query.string('client_id')
    clientId?: string,
    @param.query.string('client_secret')
    clientSecret?: string,
  ): Promise<void> {}

  @authenticate(
    STRATEGY.KEYCLOAK,
    {
      host: process.env.KEYCLOAK_HOST,
      realm: process.env.KEYCLOAK_REALM, //'Tenant1',
      clientID: process.env.KEYCLOAK_CLIENT_ID, //'onboarding',
      clientSecret: process.env.KEYCLOAK_CLIENT_SECRET, //'e607fd75-adc8-4af7-9f03-c9e79a4b8b72',
      callbackURL: process.env.KEYCLOAK_CALLBACK_URL, //'http://localhost:3001/auth/keycloak-auth-redirect',
      authorizationURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/auth`,
      tokenURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/token`,
      userInfoURL: `${process.env.KEYCLOAK_HOST}/auth/realms/${process.env.KEYCLOAK_REALM}/protocol/openid-connect/userinfo`,
    },
    queryGen('query'),
  )
  @authorize({permissions: ['*']})
  @get('/auth/keycloak-auth-redirect', {
    responses: {
      [STATUS_CODE.OK]: {
        description: 'Keycloak Redirect Token Response',
        content: {
          [CONTENT_TYPE.JSON]: {
            schema: {'x-ts-type': TokenResponse},
          },
        },
      },
    },
  })
  async keycloakCallback(
    @param.query.string('code') code: string,
    @param.query.string('state') state: string,
    @inject(RestBindings.Http.RESPONSE) response: Response,
    @inject(AuthCodeBindings.CODEWRITER_PROVIDER)
    keycloackCodeWriter: CodeWriterFn,
  ): Promise<void> {
    const clientId = new URLSearchParams(state).get('client_id');
    if (!clientId || !this.user) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    }
    const client = await this.authClientRepository.findOne({
      where: {
        clientId,
      },
    });
    if (!client || !client.redirectUrl) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.ClientInvalid);
    }
    try {
      const codePayload: ClientAuthCode<User, typeof User.prototype.id> = {
        clientId,
        user: this.user,
      };
      const token = await keycloackCodeWriter(
        jwt.sign(codePayload, client.secret, {
          expiresIn: client.authCodeExpiration,
          audience: clientId,
          issuer: process.env.JWT_ISSUER,
          algorithm: 'HS256',
        }),
      );
      response.redirect(`${client.redirectUrl}?code=${token}`);
    } catch (error) {
      this.logger.error(error);
      throw new HttpErrors.Unauthorized(AuthErrorKeys.InvalidCredentials);
    }
  }

  @authenticate(STRATEGY.BEARER, {passReqToCallback: true})
  @authorize({permissions: ['*']})
  @patch(`auth/change-password`, {
    security: OPERATION_SECURITY_SPEC,
    responses: {
      [STATUS_CODE.OK]: {
        description: 'If User password successfully changed.',
      },
    },
  })
  async resetPassword(
    @requestBody({
      content: {
        [CONTENT_TYPE.JSON]: {
          schema: getModelSchemaRef(ResetPassword, {partial: true}),
        },
      },
    })
    req: ResetPassword,
    @param.header.string('Authorization') auth: string,
    @inject(AuthenticationBindings.CURRENT_USER)
    currentUser: IAuthUserWithPermissions,
  ): Promise<SuccessResponse> {
    const token = auth?.replace(/bearer /i, '');
    if (!token || !req.refreshToken) {
      throw new HttpErrors.UnprocessableEntity(
        AuthenticateErrorKeys.TokenMissing,
      );
    }

    const refreshTokenModel = await this.refreshTokenRepo.get(req.refreshToken);
    if (refreshTokenModel.accessToken !== token) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.TokenInvalid);
    }
    if (
      refreshTokenModel.username !== req.username ||
      currentUser.username !== req.username
    ) {
      throw new HttpErrors.Forbidden(AuthorizeErrorKeys.NotAllowedAccess);
    }

    if (req.password && req.password.length <= 0) {
      throw new HttpErrors.BadRequest(AuthenticateErrorKeys.PasswordInvalid);
    }

    let changePasswordResponse: User;
    if (req.oldPassword) {
      changePasswordResponse = await this.userRepo.updatePassword(
        req.username,
        req.oldPassword,
        req.password,
      );
    } else {
      changePasswordResponse = await this.userRepo.changePassword(
        req.username,
        req.password,
      );
    }

    if (!changePasswordResponse) {
      throw new HttpErrors.UnprocessableEntity('Unable to set password !');
    }

    const userTenant = await this.userTenantRepo.findOne({
      where: {
        userId: changePasswordResponse.id,
        tenantId: currentUser.tenantId,
      },
    });
    if (!userTenant) {
      throw new HttpErrors.Unauthorized(AuthenticateErrorKeys.UserInactive);
    }

    if (userTenant.status && userTenant.status < UserStatus.ACTIVE) {
      await this.userRepo.userTenants(changePasswordResponse.id).patch({
        status: UserStatus.ACTIVE,
      });
    }
    await this.revokedTokensRepo.set(token, {token});
    await this.refreshTokenRepo.delete(req.refreshToken);
    return new SuccessResponse({
      success: true,
    });
  }

  @authenticate(STRATEGY.BEARER, {
    passReqToCallback: true,
  })
  @authorize({permissions: ['*']})
  @get('/auth/me', {
    security: OPERATION_SECURITY_SPEC,
    description: 'To get the user details',
    responses: {
      [STATUS_CODE.OK]: {
        description: 'User Object',
        content: {
          [CONTENT_TYPE.JSON]: AuthUser,
        },
      },
      ...ErrorCodes,
    },
  })
  async me(): Promise<AuthUser | undefined> {
    if (!this.user) {
      throw new HttpErrors.Unauthorized(AuthErrorKeys.TokenInvalid);
    }
    delete this.user.deviceInfo;
    return new AuthUser(this.user);
  }

  private async createJWT(
    payload: ClientAuthCode<User, typeof User.prototype.id>,
    authClient: AuthClient,
    deviceInfo: DeviceInfo,
  ): Promise<TokenResponse> {
    try {
      const size = 32;
      const ms = 1000;
      let user: User | undefined;
      if (payload.user) {
        user = payload.user;
      } else if (payload.userId) {
        user = await this.userRepo.findById(payload.userId, {
          include: [
            {
              relation: 'defaultTenant',
            },
          ],
        });
      } else {
        // Do nothing and move ahead
      }
      if (!user) {
        throw new HttpErrors.Unauthorized(
          AuthenticateErrorKeys.UserDoesNotExist,
        );
      }
      const data = await this.getJwtPayload(user, authClient, deviceInfo);
      const accessToken = jwt.sign(data, process.env.JWT_SECRET as string, {
        expiresIn: authClient.accessTokenExpiration,
        issuer: process.env.JWT_ISSUER,
        algorithm: 'HS256',
      });
      const refreshToken: string = randomBytes(size).toString('hex');
      // Set refresh token into redis for later verification
      await this.refreshTokenRepo.set(
        refreshToken,
        {
          clientId: authClient.clientId,
          userId: user.id,
          username: user.username,
          accessToken,
          externalAuthToken: (user as AuthUser).externalAuthToken,
          externalRefreshToken: (user as AuthUser).externalRefreshToken,
        },
        {ttl: authClient.refreshTokenExpiration * ms},
      );
      return new TokenResponse({
        accessToken,
        refreshToken,
        expires: moment()
          .add(authClient.accessTokenExpiration, 's')
          .toDate()
          .getTime(),
      });
    } catch (error) {
      this.logger.error(error);
      if (HttpErrors.HttpError.prototype.isPrototypeOf(error)) {
        throw error;
      } else {
        throw new HttpErrors.Unauthorized(AuthErrorKeys.InvalidCredentials);
      }
    }
  }
}
