import {inject, lifeCycleObserver, LifeCycleObserver} from '@loopback/core';
import {juggler} from '@loopback/repository';

const config = {
  name: 'inmailDb',
  connector: 'postgresql',
  url: '',
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_DATABASE,
  schema: process.env.DB_SCHEMA,
};

@lifeCycleObserver('datasource')
export class InMailDbDataSource
  extends juggler.DataSource
  implements LifeCycleObserver {
  static dataSourceName = 'inmail';
  static readonly defaultConfig = config;

  constructor(
    // You need to set datasource configuration name as 'datasources.config.inmail' otherwise you might get Errors
    @inject('datasources.config.inmail', {optional: true})
    dsConfig: object = config,
  ) {
    super(dsConfig);
  }
}
