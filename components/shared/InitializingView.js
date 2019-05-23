import React, { Component } from 'react'
import raf from 'raf';
import Console from './Console';

class InitializingView extends Component {

  constructor(props) {
    super(props);
    this.estimatedDuration = 30;
    this.timeStarted = null;
    this.updateProgress = this.updateProgress.bind(this);
    this.state = {
      showConsole: false
    }
  }

  updateProgress() {
    // Time since started
    const timeSinceBeg = (new Date().getTime() - this.timeStarted) / 1000
    if(this.progressBar) {
      let progress = Math.min(timeSinceBeg / this.estimatedDuration, 1)
      this.progressBar.style = `transform:scaleX(${progress});`
    }
    raf(this.updateProgress);
  }

  componentDidMount() {
    this.timeStarted = new Date().getTime();
    this.updateProgress();
  }

  render () {
    return (
      <div className="initializing-view pt-20 pb-20 pr-12 pl-12">
        <h2 className="text-white text-3xl font-bold">Initializing Open Data Cam</h2>
        <div className="w-1/5 mt-5 h-5 progress-bar rounded overflow-hidden">
          <div className="shadow w-full h-full bg-gray-900">
            <div
              className="bg-white py-2 progress-bar-content"
              ref={el => (this.progressBar = el)}
            >
            </div>
          </div>
        </div>
        {!this.state.showConsole &&
          <button className="btn btn-default mt-10" onClick={() => this.setState({showConsole: true})}>
            Show details
          </button>
        }
        {this.state.showConsole &&
          <button className="btn btn-default mt-10" onClick={() => this.setState({showConsole: false})}>
            Hide details
          </button>
        }
        {this.state.showConsole &&
          <div className="console mt-10">
            <Console />
          </div>
        }
        <style jsx>{`
          .initializing-view {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            width: 100%;
            height: 100%;
            background-color: black;
          }

          .console {
            width: 100%;
            flex: 1;
          }

          .progress-bar {
            min-width: 200px;
            position: relative;
          }

          .progress-bar-content {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            transform-origin: 0 0;
            transform:scaleX(0);
          }
        `}</style>
      </div>
    )
  }
}

export default InitializingView
